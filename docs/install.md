# Install, uninstall, and update

This page covers installing Apra Fleet, what the installer writes, controlling
which skills are installed, uninstalling, and self-updating.

## Requirements

- An AI coding agent CLI on the machine where you run Fleet -- Claude Code,
  Gemini, Codex, or Copilot.
- SSH access to any remote machines you want to register as members. The local
  machine needs nothing extra; remote members need only an SSH server.

## Quick install

Copy-paste the one-liner for your platform.

**macOS (Apple Silicon)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-darwin-arm64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer install
```

**Linux (x64)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-linux-x64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer install
```

**Windows (x64)** -- run in PowerShell:
```powershell
Invoke-WebRequest -Uri https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-win-x64.exe -OutFile apra-fleet-installer.exe; .\apra-fleet-installer.exe install
```

Intel Macs: there is no prebuilt `darwin-x64` binary -- build from source (see
the Development section of the [README](../README.md)).

## Manual install

Download the installer for your platform from
[GitHub Releases](https://github.com/Apra-Labs/apra-fleet/releases):

- `apra-fleet-installer-linux-x64` -- Linux (x86_64)
- `apra-fleet-installer-darwin-arm64` -- macOS (Apple Silicon)
- `apra-fleet-installer-win-x64.exe` -- Windows

Then run it:

```bash
# macOS (Apple Silicon)
chmod +x apra-fleet-installer-darwin-arm64 && ./apra-fleet-installer-darwin-arm64 install

# Linux (x64)
chmod +x apra-fleet-installer-linux-x64 && ./apra-fleet-installer-linux-x64 install
```

```powershell
# Windows
.\apra-fleet-installer-win-x64.exe install
```

## What `install` writes

| Path | What it is |
|------|-----------|
| `~/.apra-fleet/bin/apra-fleet[.exe]` | The fleet binary |
| `~/.apra-fleet/hooks/` | Shell hooks (statusline, etc.) |
| `~/.apra-fleet/scripts/` | Helper scripts |
| `~/.claude/skills/fleet/` | Fleet skill (MCP tool docs for Claude) |
| `~/.claude/skills/pm/` | PM orchestration skill |

The install also registers the MCP server (`claude mcp add apra-fleet`) and
configures a status bar icon showing fleet member activity.

**What `install` does NOT do:**

- No system-level changes -- no `/usr/local`, no PATH modification, no
  admin/sudo required.
- No network calls beyond `claude mcp add` -- the binary stays local.
- No background services or daemons -- the fleet server starts on demand when
  your AI coding agent connects.

## The `--skill` flag

By default, `install` writes both the fleet and PM skills. Use `--skill` to
control exactly which skills are installed:

| Flag | Skills installed |
|------|------------------|
| `install` (no flag) | fleet + pm (default) |
| `install --skill all` | fleet + pm |
| `install --skill fleet` | fleet only |
| `install --skill pm` | fleet + pm (pm depends on fleet) |
| `install --skill none` | neither |
| `install --no-skill` | neither (same as `--skill none`) |

## Install for Gemini and other providers

By default, `install` configures Apra Fleet for **Claude Code**. Use the `--llm`
flag to install for a different provider instead:

```bash
apra-fleet install --llm gemini      # Gemini CLI
apra-fleet install --llm codex       # OpenAI Codex CLI
apra-fleet install --llm copilot     # GitHub Copilot CLI
apra-fleet install --llm claude      # Claude Code (the default)
```

`--llm` decides which provider's configuration the installer writes to. The MCP
server registration, hooks, statusline, permissions, and skills all go into that
provider's config directory -- for example `~/.gemini/` for Gemini -- instead of
`~/.claude/`. To support more than one provider on the same machine, run
`install` once per provider.

`--llm` combines with `--skill`, e.g. `apra-fleet install --llm gemini --skill
pm`. Supported values: `claude` (default), `gemini`, `codex`, `copilot`.

After a non-Claude install, load the server by restarting that provider's CLI --
only Claude Code uses `/mcp`.

### Gemini note

`apra-fleet install --llm gemini` prints a one-time warning: the Gemini CLI does
not support background agents, so when Gemini runs as the PM/orchestrator, fleet
operations run **sequentially** -- one dispatch at a time, with no parallel
fan-out. Gemini works well as a doer or reviewer, and as an orchestrator for
serial workflows; for heavily parallel orchestration, Claude dispatches in
parallel. This is a property of the Gemini CLI, not a Fleet limitation.

## Uninstall

The built-in uninstall command surgically removes MCP registration,
permissions, hooks, status line, and skill directories without touching your
other settings:

```bash
apra-fleet uninstall
```

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview what would be removed, without modifying anything |
| `--force` | Automatically stop the running fleet server before uninstalling |
| `--yes` | Skip the confirmation prompt |
| `--llm <provider>` | Remove only a specific provider (`claude`, `gemini`, `codex`, `copilot`) |
| `--skill fleet\|pm\|all` | Remove only the specified skill directories (default: `all`) |

Examples:

```bash
# Preview the full uninstall
apra-fleet uninstall --dry-run

# Full uninstall, stop server automatically
apra-fleet uninstall --force --yes

# Remove only PM skills across all providers
apra-fleet uninstall --skill pm

# Remove only Claude's fleet skills
apra-fleet uninstall --llm claude --skill fleet
```

If the fleet server is running, uninstall aborts and tells you to re-run with
`--force`. Full detail: [docs/features/uninstall.md](features/uninstall.md).

## Self-update

Update the fleet binary to the latest release:

```bash
apra-fleet update
```

This checks the latest GitHub release, downloads the installer for your
platform, and re-runs it automatically. The server restarts with the new
binary. If you are already on the latest version it reports so and exits. Full
detail: [docs/features/update.md](features/update.md).
