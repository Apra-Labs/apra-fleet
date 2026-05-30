# Install, uninstall, and update

This page covers installing Apra Fleet, what the installer writes, controlling
which skills are installed, uninstalling, and self-updating.

## Requirements

- An AI coding agent CLI on the machine where you run Fleet - Claude Code,
  Antigravity (agy), Codex, Copilot, or Gemini.
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
| `~/.apra-fleet/data/fleet.log` | Fleet server log (HTTP transport) |
| `~/.claude/skills/fleet/` | Fleet skill (MCP tool docs for Claude) |
| `~/.claude/skills/pm/` | PM orchestration skill |
| `~/.claude/agents/*.md` | Agent definitions (claude installs; see below) |

For other providers, these are written to that provider's skill/config directories. For example, for Antigravity (`agy`), settings are written to `~/.gemini/antigravity-cli/settings.json`, and hooks / MCP configs are merged into `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json`.

The install also registers the MCP server (`claude mcp add apra-fleet`) and
configures a status bar icon showing fleet member activity.

For HTTP transport (the default), install also registers a per-user OS background
service and starts the fleet server immediately. No admin or elevation required.
See the Agent Files and Service Registration sections below.

**What `install` does NOT do:**

- No system-level changes -- no `/usr/local`, no PATH modification, no
  admin/sudo required.
- No network calls beyond `claude mcp add` -- the binary stays local.

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

## Install for other providers (Antigravity, Codex, Copilot, Gemini)

By default, `install` configures Apra Fleet for **Claude Code**. Use the `--llm`
flag to install for a different provider instead:

```bash
apra-fleet install --llm agy         # Google Antigravity CLI
apra-fleet install --llm codex       # OpenAI Codex CLI
apra-fleet install --llm copilot     # GitHub Copilot CLI
apra-fleet install --llm gemini      # Gemini CLI
apra-fleet install --llm claude      # Claude Code (the default)
```

`--llm` decides which provider's configuration the installer writes to. The MCP
server registration, hooks, statusline, permissions, and skills all go into that
provider's config directory -- for example `~/.gemini/` for Gemini -- instead of
`~/.claude/`. To support more than one provider on the same machine, run
`install` once per provider.

`--llm` combines with `--skill`, e.g. `apra-fleet install --llm gemini --skill
pm`. Supported values: `claude` (default), `agy`, `codex`, `copilot`, `gemini`.

After a non-Claude install, load the server by restarting that provider's CLI --
only Claude Code uses `/mcp`.

### Gemini note

`apra-fleet install --llm gemini` prints a one-time warning: the Gemini CLI does
not support background agents, so when Gemini runs as the PM/orchestrator, fleet
operations run **sequentially** -- one dispatch at a time, with no parallel
fan-out. Gemini works well as a doer or reviewer, and as an orchestrator for
serial workflows; for heavily parallel orchestration, Claude dispatches in
parallel. This is a property of the Gemini CLI, not a Fleet limitation.

### Agy note

`apra-fleet install --llm agy` configures Fleet for the Google Antigravity CLI.
Agy uses Google OAuth by default -- a browser-based login flow is required per
machine, so `provision_llm_auth` does **not** work for remote agy members today.

For headless or remote members, set `ANTIGRAVITY_API_KEY` (obtain from
[Google AI Studio](https://aistudio.google.com)) in the environment before
invoking fleet commands. The agy CLI checks env vars before falling back to
OAuth.

## Agent files

`install` writes agent definition files (`*.md`) to the provider's agents directory.
These files are required by `execute_prompt` when dispatching with the `agent` parameter
(e.g. `agent: "doer"`). On a fresh install, without these files, agent-named dispatches
fail with "agent not found."

| Provider | `--llm` flag | Agents directory |
|----------|-------------|-----------------|
| Claude Code | `--llm claude` (default) | `~/.claude/agents/` |
| Gemini CLI | `--llm gemini` | `~/.gemini/agents/` |
| Antigravity (agy) | `--llm agy` | `~/.gemini/antigravity-cli/agents/` |
| Codex | `--llm codex` | (no agent concept -- skipped silently) |
| Copilot | `--llm copilot` | (no agent concept -- skipped silently) |

The repo ships four agent definitions:

- `doer.md` -- general-purpose task executor
- `planner.md` -- sprint and task planning
- `reviewer.md` -- code review
- `plan-reviewer.md` -- plan review

These are bundled into the fleet binary (SEA mode) and extracted during install.
In dev mode, they are read from the `agents/` source directory. The install step
creates the agents directory with `mkdir -p` (idempotent) and writes each file.

## Service registration

For HTTP transport (the default), `install` registers the fleet server as a
per-user OS background service and starts it immediately after installing. The
server stays running across reboots. No admin or elevation is required.

| OS | Mechanism | Service unit location |
|----|-----------|----------------------|
| Windows | Scheduled Task (`schtasks /create ... /rl limited`) | Task name: `ApraFleet` |
| Linux | systemd user unit (`systemctl --user`) | `~/.config/systemd/user/apra-fleet.service` |
| macOS | launchd LaunchAgent (`launchctl bootstrap`) | `~/Library/LaunchAgents/com.apra-fleet.server.plist` |

**Stop behavior:** All platforms use `POST /shutdown` for graceful stop (HTTP to
localhost). Service managers are configured to restart on crash but NOT on clean exit
(`Restart=on-failure` on Linux, `KeepAlive.SuccessfulExit=false` on macOS). This means
`apra-fleet stop` (which triggers a clean exit) does not cause the service to restart.

**Stdio transport:** `--transport stdio` skips service registration entirely. Stdio
mode is per-client (one process per connection) and does not benefit from a
persistent background service.

**Dev mode:** Service registration is skipped in dev mode (non-SEA builds). Use
`apra-fleet start` to launch the server manually in dev mode.

Log file location: `~/.apra-fleet/data/fleet.log` (append-only, no rotation).

## Service management verbs

Once installed, use these verbs to control the fleet server:

```bash
apra-fleet start      # Start the server (idempotent -- no-op if already running)
apra-fleet stop       # Stop the server gracefully (idempotent -- no-op if not running)
apra-fleet restart    # Stop then start
apra-fleet status     # Show running state, PID, port, version, uptime, service unit state
```

`status` output example:

```
apra-fleet status
  State:    running
  PID:      12345
  Port:     7523
  URL:      http://127.0.0.1:7523
  Version:  1.4.2
  Uptime:   2h 15m 30s
  Sessions: 2
  Service:  installed (enabled)
```

If the server was installed without a service unit, `Service: not installed` is shown.
The server can still be started and stopped manually; only the automatic-at-login
behavior is absent.

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
| `--llm <provider>` | Remove only a specific provider (`claude`, `agy`, `codex`, `copilot`, `gemini`) |
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
`--force`. With `--force`, uninstall stops the server gracefully via `/shutdown`
and removes the OS service unit (Scheduled Task, systemd unit, or LaunchAgent plist)
before removing files. Full detail: [docs/features/uninstall.md](features/uninstall.md).

## Customizing model tier mapping

By default, each provider maps the three tiers (`cheap`, `standard`, `premium`)
to hardcoded model names. You can override any of these per-provider by creating
a `config.json` file in the Fleet data directory:

```
~/.apra-fleet/data/config.json
```

If you set `APRA_FLEET_DATA_DIR`, the file lives at
`$APRA_FLEET_DATA_DIR/config.json` instead.

**Schema example:**

```json
{
  "providers": {
    "agy": {
      "modelMapping": {
        "cheap":    "GPT-OSS 120B (Medium)",
        "standard": "Gemini 3.1 Pro (High)",
        "premium":  "Claude Opus 4.6 (Thinking)"
      }
    },
    "claude": {
      "modelMapping": {
        "cheap": "claude-haiku-4-5",
        "premium": "claude-opus-4-7"
      }
    }
  }
}
```

Provider keys: `claude`, `gemini`, `codex`, `copilot`, `agy`. Tier keys:
`cheap`, `standard`, `premium`. All fields are optional -- omitted tiers fall
back to the provider's built-in default.

**Precedence:** per-member override (`update_member --model-cheap/standard/premium`)
> user config > hardcoded provider default.

If the file is missing, Fleet proceeds with built-in defaults. If the JSON is
malformed, Fleet logs a warning to stderr and ignores the file.

## Self-update

Update the fleet binary to the latest release:

```bash
apra-fleet update
```

This checks the latest GitHub release, downloads the installer for your
platform, and re-runs it automatically. The server restarts with the new
binary. If you are already on the latest version it reports so and exits. Full
detail: [docs/features/update.md](features/update.md).
