# Install, uninstall, and update

This page covers installing Apra Fleet, what the installer writes, controlling
which skills are installed, uninstalling, and self-updating.

## Requirements

- An AI coding agent CLI on the machine where you run Fleet - Claude Code,
  Antigravity (agy), Codex, or Copilot.
- SSH access to any remote machines you want to register as members. The local
  machine needs nothing extra; remote members need only an SSH server.

## Quick install

Installation is the default action -- just run the binary with no arguments (or double-click it
on Windows).

**macOS (Apple Silicon)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-darwin-arm64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer
```

**Linux (x64)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-linux-x64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer
```

**Windows (x64)** -- download `apra-fleet-installer-win-x64.exe` and double-click it, or run in PowerShell:
```powershell
Invoke-WebRequest -Uri https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-win-x64.exe -OutFile apra-fleet-installer.exe; .\apra-fleet-installer.exe
```

Intel Macs: there is no prebuilt `darwin-x64` binary -- build from source (see
the Development section of the [README](../README.md)).

## Manual install

Download the installer for your platform from
[GitHub Releases](https://github.com/Apra-Labs/apra-fleet/releases):

- `apra-fleet-installer-linux-x64` -- Linux (x86_64)
- `apra-fleet-installer-darwin-arm64` -- macOS (Apple Silicon)
- `apra-fleet-installer-win-x64.exe` -- Windows

Double-click the downloaded file, or run it from the terminal. Installation is the default action:

```bash
# macOS (Apple Silicon) -- no subcommand needed; installation is the default
chmod +x apra-fleet-installer-darwin-arm64 && ./apra-fleet-installer-darwin-arm64

# Linux (x64)
chmod +x apra-fleet-installer-linux-x64 && ./apra-fleet-installer-linux-x64
```

```powershell
# Windows
.\apra-fleet-installer-win-x64.exe
```

> The `install` subcommand is still accepted and does the same thing:
> `./apra-fleet-installer install` works exactly as before.

## What `install` writes

| Path | What it is |
|------|-----------|
| `~/.apra-fleet/bin/apra-fleet[.exe]` | The fleet binary |
| `~/.apra-fleet/hooks/` | Shell hooks (statusline, etc.) |
| `~/.apra-fleet/scripts/` | Helper scripts |
| `~/.apra-fleet/node_modules/` | Shared on-disk workflow runtime (`@apralabs/apra-fleet-workflow`, `@apralabs/apra-fleet-client`, vendored `ajv` + deps) that `apra-fleet workflow <name>` and any user-authored workflow resolve bare specifiers against -- see `docs/authoring-workflows.md` |
| `~/.apra-fleet/schemas/` | Installed agent role verdict/input JSON schemas (17 files); the `APRA_FLEET_SE_SCHEMAS_DIR` default the workflow launcher sets |
| `~/.apra-fleet/workflows/` | Installed workflows (`.installed.json` + one directory per workflow, built-in or user-authored); run with `apra-fleet workflow <name> [args...]` -- see `docs/authoring-workflows.md` |
| `~/.claude/skills/fleet/` | Fleet skill (MCP tool docs for Claude) |
| `~/.claude/skills/pm/` | PM orchestration skill |
| `~/.claude/skills/pm/cost.js` | Auto-generated CJS module with sprint cost functions (all providers with PM) |
| `~/.claude/workflows/auto-sprint.js` | Full auto-sprint workflow (Claude only) |
| `~/.claude/skills/auto-sprint-args/` | Args contract for the `/auto-sprint` workflow (Claude only) |
| `~/.claude/skills/fleet-sprint-cli/` | How to launch `apra-fleet workflow fleet-sprint` -- flag contract, preconditions, detached launch (all providers) |
| `~/.claude/agents/` | PM role-agent files (planner, doer, reviewer, etc.), plus `schemas/` and `_shared/` -- written whenever PM is installed and the provider has an agents directory (not codex/copilot) |

For other providers, these are written to that provider's skill/config directories. For example, for Antigravity (`agy`), settings are written to `~/.gemini/antigravity-cli/settings.json`, and hooks / MCP configs are merged into `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json`.

This local install only covers the machine you run it on. Remote fleet members get their own copy of the PM agent files independently -- `register_member` and `update_member` push them on first contact, and `execute_prompt` re-checks and re-provisions any missing or stale files on first dispatch to that member each server run (so an existing member picks up new agent files after you upgrade Fleet, without needing to be re-registered). Local members are unaffected -- they share the operator's home directory above.

The install also registers the MCP server (`claude mcp add apra-fleet`) and
configures a status bar icon showing fleet member activity.

### Two sprint entry points -- do not confuse them

`apra-fleet` ships **two separate, independently maintained** sprint
implementations:

| | `auto-sprint` (Claude Code workflow) | `fleet-sprint` (apra-fleet CLI workflow) |
|---|---|---|
| Written by | `install` (table above) | The root `@apralabs/apra-fleet` npm package's `bin.fleet-sprint`, resolving to `dist/fleet-sprint.mjs` |
| Providers | Claude Code only | Any provider a fleet member is registered with (Claude, Codex, Copilot, Antigravity/agy) |
| Source package | `packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js` | `packages/apra-fleet-se` (esbuild-bundled, apra-fleet-3ns.2) |
| Model selection | Literal Claude model names | Fleet's `cheap`/`standard`/`premium` tier keywords, per-member |
| How you run it | `/auto-sprint <bead-ids>` inside a Claude Code session (the Workflow tool) | `apra-fleet workflow fleet-sprint --issue ... --members ... --branch ... --base ...` -- the normal form. The same bundle is also exposed directly as a `fleet-sprint` bin (`npx fleet-sprint ...`, or bare if `@apralabs/apra-fleet` is installed with `-g`). See `packages/apra-fleet-se/docs/cli-reference.md` |

If you installed `apra-fleet` via `npm install -g @apralabs/apra-fleet`
(or `npx @apralabs/apra-fleet`), the `fleet-sprint` bin is available
immediately alongside `apra-fleet` -- no separate install step. It requires
the `apra-fleet` MCP server to be reachable (it spawns/connects to it over
stdio the same way `apra-fleet` itself does); see
`packages/apra-fleet-se/docs/cli-reference.md` for its server- and
schema-resolution order across dev/bundled/standalone layouts.

### The `apra-fleet workflow <name>` subcommand

`install` also populates `~/.apra-fleet/node_modules/`, `~/.apra-fleet/schemas/`,
and `~/.apra-fleet/workflows/` (see the directory table above) so that
`apra-fleet workflow <name> [args...]` -- the SEA-binary workflow runner --
can run built-in workflows (`fleet-sprint`, `hello-world`) or any
user-authored workflow with zero system Node required. See
`docs/authoring-workflows.md` for the full authoring contract.

The workflow launcher and the `apra-fleet` MCP server it talks to are
always separate processes. Set `APRA_FLEET_TRANSPORT=http` (the default) or
`APRA_FLEET_TRANSPORT=stdio` to control how the launcher reaches that
server: `http` (default) attaches to the already-running installed-service
singleton at `http://localhost:${APRA_FLEET_PORT:-7523}/mcp` and spawns
nothing; `stdio` self-spawns a private server the same way the `fleet-sprint`
bin does. See `docs/adr-workflow-server-resolution.md` for the full
resolution order (this same order also governs where role schemas resolve
from in the installed-binary case: `APRA_FLEET_SE_SCHEMAS_DIR`, set by the
launcher to `~/.apra-fleet/schemas`, is now tier 1 of the schema resolution
described in `packages/apra-fleet-se/docs/cli-reference.md`).

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

## Install for other providers (Antigravity, Codex, Copilot)

By default, `install` configures Apra Fleet for **Claude Code**. Use the `--llm`
flag to install for a different provider instead:

```bash
apra-fleet --llm agy         # Google Antigravity CLI
apra-fleet --llm codex       # OpenAI Codex CLI
apra-fleet --llm copilot     # GitHub Copilot CLI
apra-fleet --llm claude      # Claude Code (the default)
```

The `install` subcommand is also accepted and does the same thing:
`apra-fleet install --llm agy` works exactly as before.

`--llm` decides which provider's configuration the installer writes to. The MCP
server registration, hooks, statusline, permissions, and skills all go into that
provider's config directory -- for example `~/.gemini/antigravity-cli/` for
Antigravity -- instead of `~/.claude/`. To support more than one provider on the
same machine, run `install` once per provider.

`--llm` combines with `--skill`, e.g. `apra-fleet install --llm agy --skill
pm`. Supported values: `claude` (default), `agy`, `codex`, `copilot`.

After a non-Claude install, load the server by restarting that provider's CLI --
only Claude Code uses `/mcp`.

### Agy note

`apra-fleet install --llm agy` configures Fleet for the Google Antigravity CLI.
Agy uses Google OAuth by default -- a browser-based login flow is required per
machine, so `provision_llm_auth` does **not** work for remote agy members today.

For headless or remote members, set `ANTIGRAVITY_API_KEY` (obtain from
[Google AI Studio](https://aistudio.google.com)) in the environment before
invoking fleet commands. The agy CLI checks env vars before falling back to
OAuth.

## Uninstall

The built-in uninstall command surgically removes MCP registration,
permissions, hooks, status line, skill directories, and PM agent files
(`~/.claude/agents/`, or the equivalent provider directory) without touching
your other settings:

```bash
apra-fleet uninstall
```

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview what would be removed, without modifying anything |
| `--force` | Automatically stop the running fleet server before uninstalling |
| `--yes` | Skip the confirmation prompt |
| `--llm <provider>` | Remove only a specific provider (`claude`, `agy`, `codex`, `copilot`) |
| `--skill fleet\|pm\|workflows\|all` | Remove only the specified skill directories (default: `all`) |

`--skill workflows` removes the shared workflow runtime and schemas
(`~/.apra-fleet/node_modules/`, `~/.apra-fleet/schemas/`) plus only the
built-in workflow subdirectories under `~/.apra-fleet/workflows/` (read from
`workflows/.installed.json`'s `builtin` list, falling back to the static
built-in name list if that manifest is missing). Any user-authored
`workflows/<name>/` directories are left in place, and the command reports
which ones it kept; the `workflows/` root itself is only removed if nothing
user-authored remains in it.

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

# Remove only the workflow runtime + built-in workflows, keep user-authored ones
apra-fleet uninstall --skill workflows
```

If the fleet server is running, uninstall aborts and tells you to re-run with
`--force`. Full detail: [docs/features/uninstall.md](features/uninstall.md).

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

Provider keys: `claude`, `codex`, `copilot`, `agy`. Tier keys:
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

### Stopping a running server before an overwrite install

`install --force` (and `update`, which drives the same path) must stop the
currently-running server before copying the new binary over the installed
path, since the OS refuses to overwrite a binary that is still mapped into a
running process. A single termination signal followed by a fixed delay is not
reliable: a singleton that is mid-request can take longer to exit than an
arbitrary fixed sleep, and a copy attempted before it actually exits fails
outright and leaves the old server running.

The install path instead polls process liveness over a bounded grace window
after the initial termination signal, and escalates to a harder kill signal
if the process is still alive once that window elapses, polling again over a
second (shorter) window before giving up. The binary copy is only attempted
once the old process is confirmed gone. Symmetrically, the "stopped running
server" success message is gated on that same confirmation rather than
printed unconditionally -- if the process is still detected running after
both the initial signal and the escalation, install reports a clear error
(with the manual kill command for the platform) and exits non-zero instead of
proceeding into a copy that would fail anyway or claiming success it can't
back up.

### Replaying the npm-publish smoke step locally with an unrelated server running

CI's "Pack + install into a clean temp prefix (fleet-sprint smoke test)" step
packs the CLI and installs it into an isolated, throwaway prefix. That step
(and any local replay of it) is safe to run even while an unrelated
apra-fleet server is already up on the same machine, because the
running-process guard is scoped to the install being performed rather than
to any apra-fleet process anywhere on the OS: it only fires when the running
server's data dir matches the data dir this install targets, or when the
running executable it detects lives under the install prefix being written
(the ETXTBSY case). A server running against a different data dir and a
different install prefix does not trip it.

To replay the step locally, isolate the install the same way CI does by
pointing these env vars at throwaway locations before running
`apra-fleet install`:

- `HOME` (or `USERPROFILE` on Windows) -- so the default data dir and install
  prefix resolve under a temp directory instead of your real home.
- `APRA_FLEET_DATA_DIR` -- overrides the data dir directly if you want it
  separate from `HOME`.
- The install prefix (where the packed CLI is installed) -- point it at a
  clean temp directory distinct from any prefix an existing server was
  installed into.

`install --force` is not needed for this replay, and must not be used just
to kill an unrelated apra-fleet server -- `--force` exists to stop the
server that owns the install being overwritten, not to clear the machine of
unrelated servers so a differently-scoped install can proceed. As long as
the data dir and install prefix are isolated from any running server, a
plain `apra-fleet install` (no `--force`) completes without the guard
firing.
