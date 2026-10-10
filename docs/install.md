# Install, uninstall, and update

This page covers installing Apra Fleet, what the installer writes, controlling
which skills are installed, uninstalling, and self-updating.

## Requirements

- An AI coding agent CLI on the machine where you run Fleet - Claude Code,
  Antigravity (agy), Codex, Copilot, or OpenCode.
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

**macOS (Intel, x64)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-installer-darwin-x64 -o apra-fleet-installer && chmod +x apra-fleet-installer && ./apra-fleet-installer
```

## Manual install

Download the installer for your platform from
[GitHub Releases](https://github.com/Apra-Labs/apra-fleet/releases):

- `apra-fleet-installer-linux-x64` -- Linux (x86_64)
- `apra-fleet-installer-darwin-arm64` -- macOS (Apple Silicon)
- `apra-fleet-installer-darwin-x64` -- macOS (Intel, x64)
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

> The `install` subcommand is also accepted and does the same thing:
> `./apra-fleet-installer install`.

## What `install` writes

| Path | What it is |
|------|-----------|
| `~/.apra-fleet/bin/apra-fleet[.exe]` | The fleet binary |
| `~/.apra-fleet/hooks/` | Shell hooks (statusline, etc.) |
| `~/.apra-fleet/scripts/` | Helper scripts |
| `~/.apra-fleet/node_modules/` | Shared on-disk workflow runtime (`@apralabs/apra-fleet-workflow`, `@apralabs/apra-fleet-client`, vendored `ajv` + deps) that `apra-fleet workflow <name>` and any user-authored workflow resolve bare specifiers against -- see `docs/authoring-workflows.md` |
| `~/.apra-fleet/schemas/` | Installed agent role verdict/input JSON schemas; the `APRA_FLEET_SE_SCHEMAS_DIR` default the workflow launcher sets |
| `~/.apra-fleet/workflows/` | Installed workflows (`.installed.json` + one directory per workflow, built-in or user-authored); run with `apra-fleet workflow <name> [args...]` -- see `docs/authoring-workflows.md` |
| `~/.claude/skills/fleet/` | Fleet skill (MCP tool docs for Claude) |
| `~/.claude/skills/pm/` | PM orchestration skill |
| `~/.claude/skills/pm/cost.js` | Auto-generated CJS module with sprint cost functions (all providers with PM) |
| `~/.claude/workflows/auto-sprint.js` | Full auto-sprint workflow (Claude only) |
| `~/.claude/skills/auto-sprint-args/` | Args contract for the `/auto-sprint` workflow (Claude only) |
| `~/.claude/skills/fleet-sprint-cli/` | How to launch `apra-fleet workflow fleet-sprint` -- flag contract, preconditions, detached launch (all providers) |
| `~/.claude/agents/` | PM role-agent files (planner, doer, reviewer, etc.), plus `schemas/` and `_shared/` -- written whenever PM is installed and the provider has an agents directory (not codex/copilot) |

For other providers, these are written to that provider's skill/config directories. For example, for Antigravity (`agy`), settings are written to `~/.gemini/antigravity-cli/settings.json`, and hooks / MCP configs are merged into `~/.gemini/config/hooks.json` and `~/.gemini/config/mcp_config.json`. These configure the agy CLI you run the orchestrator in; agy members get their grants in their own agy project instead (see [Antigravity (agy) provider](agy-provider.md)).

This local install only covers the machine you run it on. Remote fleet members get their own copy of the PM agent files independently -- `register_member` and `update_member` push them on first contact, and `execute_prompt` re-checks and re-provisions any missing or stale files on first dispatch to that member each server run (so an existing member picks up new agent files after you upgrade Fleet, without needing to be re-registered). Local members are unaffected -- they share the operator's home directory above.

The install also registers the MCP server and configures a status bar icon
showing fleet member activity. The registration is written directly into the
provider's user-scope config (for Claude, `mcpServers.apra-fleet` in
`~/.claude.json`), not through `claude mcp add`, so the access secret never
appears on a command line. It carries this install's access secret
(`~/.apra-fleet/data/member-access.key`, owner-only, created on first install
or server start) in the `X-Apra-Fleet-Member-Secret` header, and every config
file holding it is made owner-only. The server refuses a `/mcp` request
without the secret (HTTP 401 `access secret required`); re-run
`apra-fleet install` to rewrite a registration that lacks it. (A `--transport
stdio` install needs no secret and still registers with `claude mcp add`.)

### Two sprint entry points -- do not confuse them

`apra-fleet` ships **two separate, independently maintained** sprint
implementations:

| | `auto-sprint` (Claude Code workflow) | `fleet-sprint` (apra-fleet CLI workflow) |
|---|---|---|
| Written by | `install` (table above) | `install` populates `~/.apra-fleet/workflows/`; the engine ships as source inside the `@apralabs/apra-fleet` package |
| Providers | Claude Code only | Any provider a fleet member is registered with (Claude, Codex, Copilot, Antigravity/agy, OpenCode) |
| Source package | `packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js` | `packages/apra-fleet-se` (shipped unbundled as source) |
| Model selection | Literal Claude model names | Fleet's `cheap`/`standard`/`premium` tier keywords, per-member |
| How you run it | `/auto-sprint <bead-ids>` inside a Claude Code session (the Workflow tool) | `apra-fleet workflow fleet-sprint --issue ... --members ... --branch ... --base ...`. See `packages/apra-fleet-se/docs/cli-reference.md` |

There is no separate `fleet-sprint` bin: the root package's `bin` field
contains only `apra-fleet`, and the engine is reached through
`apra-fleet workflow fleet-sprint`. See `docs/npm-packaging.md` for the
shipped package layout and `packages/apra-fleet-se/docs/cli-reference.md` for
the engine's server- and schema-resolution order.

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
nothing; `stdio` (explicit only) runs a private server as a subprocess; if no singleton is running, `http` mode starts the shared one. See `docs/adr-workflow-server-resolution.md` for the full
resolution order (this same order also governs where role schemas resolve
from in the installed-binary case: `APRA_FLEET_SE_SCHEMAS_DIR`, set by the
launcher to `~/.apra-fleet/schemas`, is tier 1 of the schema resolution
described in `packages/apra-fleet-se/docs/cli-reference.md`).

**What `install` does NOT do:**

- No system-level changes -- no `/usr/local`, no PATH modification, no
  admin/sudo required.
- The MCP registration makes no network calls -- the binary stays local.
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

## Install for other providers (Antigravity, Codex, Copilot, OpenCode)

By default, `install` configures Apra Fleet for **Claude Code**. Use the `--llm`
flag to install for a different provider instead:

```bash
apra-fleet --llm agy         # Google Antigravity CLI
apra-fleet --llm codex       # OpenAI Codex CLI
apra-fleet --llm copilot     # GitHub Copilot CLI
apra-fleet --llm opencode    # OpenCode CLI
apra-fleet --llm claude      # Claude Code (the default)
```

The `install` subcommand is also accepted and does the same thing:
`apra-fleet install --llm agy`.

`--llm` decides which provider's configuration the installer writes to. The MCP
server registration, hooks, statusline, permissions, and skills all go into that
provider's config directory -- for example `~/.gemini/antigravity-cli/` for
Antigravity -- instead of `~/.claude/`. To support more than one provider on the
same machine, run `install` once per provider.

`--llm` combines with `--skill`, e.g. `apra-fleet install --llm agy --skill
pm`. Supported values: `claude` (default), `agy`, `codex`, `copilot`,
`opencode`.

After a non-Claude install, load the server by restarting that provider's CLI --
only Claude Code uses `/mcp`.

### Agy note

`apra-fleet install --llm agy` configures Fleet for the Google Antigravity CLI.
Agy uses Google OAuth by default -- a browser-based login flow is required per
machine. For headless or remote members, use an `ANTIGRAVITY_API_KEY` (obtain
from [Google AI Studio](https://aistudio.google.com)): pass it to
`provision_llm_auth` as `api_key`, or set it in the member's environment. The
agy CLI checks env vars before falling back to OAuth.

agy model overrides (below) take agy's model slug ids, as printed by
`agy models`. How agy members are bound to their own agy project, how grants
are written and how permission denials are reported is described in
[Antigravity (agy) provider](agy-provider.md).

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
| `--llm <provider>` | Remove only a specific provider (`claude`, `agy`, `codex`, `copilot`, `opencode`) |
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
`--force`. A full uninstall also stops and removes a leftover supervisor OS service
(systemd user unit, launchd agent, or Windows scheduled task) that runs the installed
tree, and ends with a "Kept (intentionally)" list (`data/`, `fleet.key`, user workflows).
Full detail: [docs/features/uninstall.md](features/uninstall.md).

## Members without a service manager (standalone mode)

A member install (`install --member`) normally registers a user-mode auto-start:
a systemd user unit on Linux, a launchd agent on macOS, a scheduled task (or a
logon Run entry) on Windows. Some member hosts have no usable service manager:
Docker containers, WSL without systemd, minimal distros, or a non-root user with
no systemd user session. On those hosts the member install still succeeds and
prints `[WARN] MEMBER-STANDALONE: ...` with the reason; its summary shows
`Service: not registered -- standalone mode (MEMBER-STANDALONE)`.

In standalone mode the server is started by the fleet, not by the host:

- Right after the install, `register_member` / `update_member` run the
  member's own `apra-fleet start` (under `nohup`, with
  `--autostart --pidfile <home>/.apra-fleet/data/standalone.pid`). The server
  is spawned detached in its own session, so it survives the SSH session; its
  output goes to `<home>/.apra-fleet/data/fleet.log` and its pid to
  `standalone.pid`.
- Every later member probe (`update_member`, `member_detail` with
  `refresh: true`, the sprint's member init) that finds the server down starts
  it again the same way and retries the check.
- A deliberate `apra-fleet stop` on the member is respected: the fleet does not
  restart a server its user stopped.
- When the server cannot be kept running (start fails, it dies during startup,
  it never answers `/health`, or its user stopped it), `fleetMcp` is
  `unavailable(member-server-not-running)`. The detail carries the exact cause,
  including the last lines of the member's server log, and the `fleetMcp fix:`
  line gives the one-line remedy.

> **WARNING: a standalone member server is NOT restarted on reboot.** After the
> member host (or container) restarts, the server stays down until the next
> member probe starts it (`update_member`, `member_detail` with
> `refresh: true`, or a sprint's member init), or until someone starts it by
> hand. Until then the member has no KB/code tools from its own apra-fleet.

Check and start it by hand, on the member, as the member user:

```bash
~/.apra-fleet/bin/apra-fleet status   # State: running / stopped; Service: not installed
~/.apra-fleet/bin/apra-fleet start    # starts the standalone server detached
```

To get a restart on reboot, give the host a working user-mode service manager
(for example enable systemd in WSL, or run the container with an init system),
then run `update_member {member_id, fleet_install: "auto"}` again.

## Replace a full install on a member

A fleet member machine needs a **member install only** (`apra-fleet install
--member`: the server plus its user-mode auto-start, no skills, no workflows, no
user-scope MCP entry). There is one member install per Unix user (per Windows
user); members that share a user share it and each one self-registers its own
uuid. A member that already has a *full* install (or a member install older than
the `data/member-install.json` marker) is left alone by the fleet and reported as
`fleetMcp` `unavailable(full-install-running)`; its owner replaces it with a
member install using the steps below. The takeover flag
`--force-stop-full-install` is no longer needed for KB or code-tool access:
replacing the install supersedes it. The `full-install-running` detail prints
these same steps with this member's paths already resolved, after staging the
orchestrator's current installer in `<home>/.apra-fleet/staging/`.

### Pre-check

- No sprint is using the member.
- Installed version: `<home>/.apra-fleet/bin/apra-fleet --version`.
- Port 7523 on 127.0.0.1 is free or held by THIS user's apra-fleet:
  `ss -ltnp | grep 7523` or `lsof -iTCP:7523 -sTCP:LISTEN` (Windows:
  `Get-NetTCPConnection -LocalPort 7523`).
- Linux: is a `fleet-supervisor` user unit present?
  `systemctl --user status fleet-supervisor`.

### Steps

Replace `<home>` with the member user's home directory (spelled out, not `~`),
and `<provider>` with the member's LLM provider (`claude`, `agy`, `codex`,
`copilot`, `opencode`). `<staged>` is the installer the fleet staged (or that you
downloaded from the release page) for this OS/arch, normally
`<home>/.apra-fleet/staging/apra-fleet` (`apra-fleet.exe` on Windows).

a. Back up the data directory AND the signing key, which lives outside `data/`:

   ```bash
   # posix (Linux, macOS)
   cp -R '<home>/.apra-fleet/data' '<home>/.apra-fleet-data.full-install.bak'
   cp '<home>/.apra-fleet/fleet.key' '<home>/.apra-fleet-data.full-install.bak/'
   ```

   ```powershell
   # Windows (PowerShell)
   Copy-Item -Recurse -LiteralPath '<home>\.apra-fleet\data' -Destination '<home>\.apra-fleet-data.full-install.bak'
   Copy-Item -LiteralPath '<home>\.apra-fleet\fleet.key' -Destination '<home>\.apra-fleet-data.full-install.bak\'
   ```

b. Uninstall with the INSTALLED binary (old full installs have it). This stops
   the server and removes the service unit or scheduled task, the binary, hooks,
   skills, agents and the user-scope MCP registration; it keeps `data/`:

   ```bash
   '<home>/.apra-fleet/bin/apra-fleet' uninstall --force --yes
   ```

   ```powershell
   & '<home>\.apra-fleet\bin\apra-fleet.exe' uninstall --force --yes
   ```

c. Move the old data aside (the backup from step a stays as the rollback copy):

   ```bash
   mv '<home>/.apra-fleet/data' '<home>/.apra-fleet/data.replaced'
   ```

   ```powershell
   Move-Item -LiteralPath '<home>\.apra-fleet\data' -Destination '<home>\.apra-fleet\data.replaced'
   ```

d. Linux only: uninstall leaves `fleet-supervisor.service` RUNNING with its
   `serve.mjs` deleted. Stop and remove it:

   ```bash
   systemctl --user stop fleet-supervisor
   systemctl --user disable fleet-supervisor
   mv '<home>/.config/systemd/user/fleet-supervisor.service' '<home>/.apra-fleet-data.full-install.bak/'
   systemctl --user daemon-reload
   ```

e. Run the STAGED current installer (not the old binary, which predates the
   `--member` flags):

   ```bash
   chmod +x '<staged>' && '<staged>' install --member --llm <provider> --force
   ```

   ```powershell
   & '<staged>' install --member --llm <provider> --force
   ```

f. On the orchestrator, for every member on that Unix user run `update_member`
   with `fleet_install: "auto"`. Each member self-registers its own uuid on the
   new member install.

### Verify

- `<home>/.apra-fleet/bin/apra-fleet --version` shows the orchestrator version.
- `<home>/.apra-fleet/data/member-install.json` exists (a member install writes
  it before the auto-start step). On a host with no usable service manager the
  install still succeeds in standalone mode (`MEMBER-STANDALONE`, see "Members
  without a service manager (standalone mode)" above) and step f starts the
  server.
- `apra-fleet call --member <uuid> --list-tools` lists the `kb_*` and `code_*`
  tools and none of `execute_*`, `register_*` or `credential_*`.
- `member_detail` with `refresh: true` shows `fleetMcp` `available`.

### Rollback

Run `apra-fleet uninstall --force --yes` for the member install, restore the
backed-up data directory (`<home>/.apra-fleet-data.full-install.bak` back to
`<home>/.apra-fleet/data`, plus `fleet.key` to `<home>/.apra-fleet/fleet.key`),
and re-run the old full installer.

### Evidence

Done by hand on a Linux member and an Intel Mac member on 2026-10-05; both ended
with `session_stats` showing kb 1 / code 1.

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
        "cheap":    "gemini-3.8-flash-low",
        "standard": "gemini-3.8-flash-high",
        "premium":  "gemini-3.1-pro-high"
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

Provider keys: `claude`, `codex`, `copilot`, `agy`, `opencode`. Tier keys:
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

**A launchd/systemd/Windows-service-managed server defeats a pkill-first
approach entirely**, not just slows it down. On macOS, the LaunchAgent
installed for the server (`~/Library/LaunchAgents/com.apra-fleet.server.plist`)
is registered with `KeepAlive` set for a non-successful exit, so the service
manager relaunches the server (as a new PID) the instant a `SIGTERM`/
`SIGKILL` reaches it -- signalling the process by name after that point
cannot win the race, since the pid it is tracking is already stale, and a
liveness poll racing the relaunch would report the same "could not stop the
running server" failure no matter how long the grace windows are.

`install --force` avoids this by stopping the registered **service** first,
never signalling the bare process as the first move: it snapshots the
currently-running apra-fleet pids *before* touching anything, then (when a
service is registered) calls the platform `ServiceManager.stop()` for a
graceful shutdown, and only escalates to a direct kill signal if a poll
afterward still finds a process alive **with the same pid it snapshotted
before stopping** -- i.e. nothing relaunched and there is no supervisor race
to lose. If a pid appears that was not in the original snapshot, that is
conclusive evidence of a supervisor relaunch (not a process refusing to
die), and install reports it as exactly that, with the platform's service-
stop command, instead of retrying a signal against a name that will keep
being relaunched forever. The server's own log corroborates this case with
consecutive startup lines under a different PID each time a kill was
attempted. Killing the process without first stopping its service
registration is still not a valid workaround for any code path that has to
solve this problem elsewhere -- it reproduces the exact race above.

If the guard stopped a registered service to win the copy, install restarts
that service again once the new binary is in place -- the stop above exists
only to release the file lock for the overwrite, not to leave the operator's
previously-running server down. This restart is conditional on the service
having actually been stopped by this guard; a plain `apra-fleet install`
run that never touched a running service does not attempt to start one that
was never asked to stop.

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
