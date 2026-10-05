# Install, uninstall, and update

This page covers installing Apra Fleet, what the installer writes, controlling
which skills are installed, uninstalling, and self-updating.

## Requirements

- An AI coding agent CLI on the machine where you run Fleet - Claude Code,
  Antigravity (agy), Codex, Copilot, or OpenCode.
- SSH access to any remote machines you want to register as members. The local
  machine needs nothing extra; remote members need only an SSH server.

## Prerequisites

Apra Fleet core -- the console, the MCP server, and Dolt -- needs no Node.js
at all; it runs from the installed binary alone.

fleet-se (the fleet-sprint engine, the fleet supervisor, and `bd`) is
different: it requires **Node.js 22.16.0 or newer, plus npm**, by design. `bd`
is installed as an npm global package pinned to `@beads/bd@1.3.0` -- it does
not ship as a standalone binary, and installing does not skip it silently.

If Node.js or npm is missing (or Node.js is older than 22.16.0) when you run
`install` with the default `--workflows all`, the installer stops with a
non-zero exit and prints:

```
fleet-se requires Node.js 22.16+ and npm: install them and re-run, or use --workflows none for the core console only
```

To install only the core console -- no Node.js/npm requirement at all -- pass
`--workflows none`. This skips the fleet-se workflow assets, the fleet
supervisor, and the `bd` install entirely; the installer reports fleet-se as
`NOT INSTALLED` in its summary and exits 0.

**Design note:** an earlier approach shipped `bd` as a standalone
release-binary download (mirroring how Dolt is installed), specifically to
avoid a Node.js dependency for `bd` itself. That approach was deliberately
abandoned: fleet-se already requires Node.js/npm for the supervisor and the
fleet-sprint engine, so a binary-only `bd` would only avoid the dependency
for one of three fleet-se components while still requiring it for the other
two -- removing a real benefit while adding a second install mechanism (and a
second checksum-verification surface) to maintain. `bd` installs as an npm
global instead, gated behind the same node/npm prerequisite check as the
rest of fleet-se. The version pin (`@beads/bd@1.3.0`) has exactly one
TypeScript owner (`src/cli/beads-pin.ts`) that every other consumer imports;
the one unavoidable duplicate is the separate, dependency-free `apra-pm`
installer (plain Node with no build step, so it cannot import a TypeScript
module) -- its copy of the pin is held equal to the owner by a dedicated
equality test that fails the moment the two disagree. Any future pinned
version constant that needs a duplicate outside the TypeScript build should
follow this pattern: one canonical owner plus an equality test pinning every
duplicate, rather than a bare literal copied by hand into each consumer.

**Ordering:** the prerequisite gate runs first -- before the installer stops
any running server, before it mints `fleet.key`, and before it writes a
single file. On a machine with no Node.js and the default `--workflows all`,
a failed gate exits non-zero leaving the machine exactly as it was found; it
is safe to install Node.js and re-run. (This was previously a known gap: the
gate used to run mid-install, after the binary copy, hooks, scripts, settings
and skills had already been written.)

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

The install also registers the MCP server (`claude mcp add apra-fleet`) and
configures a status bar icon showing fleet member activity.

### Two OS-level services

A binary (SEA) install with the default `--transport http` registers **two
independent auto-starting OS services**, each with its own unit/plist/task so
either can be stopped, restarted or removed without touching the other:

| Service | What runs | Linux | macOS | Windows |
|---|---|---|---|---|
| MCP server | `~/.apra-fleet/bin/apra-fleet --transport http` | `apra-fleet.service` | `com.apra-fleet.server` | `ApraFleet` |
| Fleet supervisor | `~/.apra-fleet/bin/apra-fleet supervisor` | `fleet-supervisor.service` | `com.apra-fleet.supervisor` | `ApraFleetSupervisor` |

Notes:

- The supervisor is the always-on fleet-sprint dashboard/API process. The
  registered unit runs the installed binary's own `supervisor` subcommand --
  one argument, no separate `node` executable and no `serve.mjs` path in the
  unit itself. That subcommand then resolves and boots the installed
  `serve.mjs` on the binary's own embedded Node runtime. It is registered only
  when the workflow assets that contain it were installed (skipped by
  `--workflows none`), logs to `~/.apra-fleet/data/fleet-supervisor.log`, and
  is `Restart=no` (started at boot/login; an exit is treated as intentional).
- **Project folder:** the supervisor resolves which project's beads database
  to work against by this precedence, in order:
  1. an explicit `--beads-dir <path>` passed directly to `serve.mjs` (not
     used by the registered service unit, which passes no extra arguments --
     see below);
  2. the project folder **persisted** in `supervisor.config.json`, under the
     supervisor's own data dir (`~/.apra-fleet-se` by default, or
     `FLEET_SE_DATA_DIR` when set);
  3. walking up from the supervisor's working directory looking for a
     `.beads` folder -- the same discovery `bd` itself performs. What is
     reported as the project folder in this case is the folder that was
     FOUND (the one holding `.beads`, which is also the working directory
     handed to every sprint), not the subfolder the supervisor happened to
     be started from.

  Step 2 is what makes a service-registered supervisor reach a real
  project's beads DB: its working directory is the engine's own installed
  path (`~/.apra-fleet/workflows/fleet-sprint`), which has no `.beads` of its
  own, so step 3 alone would never find a real project. Set the persisted
  folder either at install time (`apra-fleet install --project-dir
  <path>`) or later from the console's Projects page (`/ui/projects` under
  the fleet-supervisor workflow package), which reads and writes the same
  file through the supervisor's own guarded API. Setting it from either
  place requires restarting the supervisor to take effect (the config is
  read once, at startup); the console page states this explicitly after a
  save.

  **A folder is only accepted if a sprint could actually run in it.** Both
  the install flag and the console refuse a folder that does not have all
  of: an initialised `.beads` (`bd init`), a git `origin` remote
  (`git remote add origin <url>`), and bd's `sync.remote` set
  (`bd config set sync.remote <url>`). The refusal names every missing
  piece and the command that fixes it, and nothing is written. This is not
  strictness for its own sake: the sprint engine's beads identity check
  treats an incomplete identity as fatal, so accepting such a folder would
  produce a supervisor that starts cleanly and then fails every launch.
  `bd` must be runnable for the `sync.remote` check, so `apra-fleet
  install` runs that one check (and the write) only AFTER its own Beads
  step has provisioned bd -- a fresh machine with no bd yet is not a
  reason to reject a good folder. The checks that need no bd (the path
  itself, `.beads`, the git remote) still run before the install writes a
  single file, so a typo'd path costs you nothing. If bd is still not
  runnable by the time the deferred check runs -- only possible with
  `--workflows none`, which skips the Beads step -- the install fails
  saying so rather than skipping the check. Either input also accepts the
  folder's `.beads` path and normalises it to the parent, the same
  convenience `--beads-dir` offers.

  A folder that was already persisted and has since become incomplete is a
  different case: the supervisor still starts (see below) and reports the
  missing field(s) and their fix in `GET /api/health`'s `beadsWarning`, so
  the console stays reachable to correct it.

  **Staleness-tolerant, but a typo is still fatal:** a persisted folder that
  has since been moved, renamed, or deleted does **not** stop the supervisor
  from starting -- it starts, warns naming the missing path and how to fix
  it, and reports its beads status as unknown until the setting is corrected.
  If the SAME path becomes valid again (e.g. a remounted volume), `GET
  /api/health?refresh=1` re-probes it with no restart needed; saving a
  DIFFERENT project folder from the console still requires a restart to
  take effect, exactly like the install-time/flag setting. This is
  deliberately asymmetric with an explicit `--beads-dir` typo'd on the
  command line, which is always a hard error: an operator who just typed a
  flag should never have that typo silently ignored, while a persisted
  setting can go stale for reasons the operator was not present for (a
  moved checkout, an unmounted volume, a reimaged machine), and a
  supervisor that refuses to boot cannot serve the very console page that
  would let them fix it.

  See
  [`packages/apra-fleet-se/docs/project-model.md`](../packages/apra-fleet-se/docs/project-model.md)
  for the full supervisor/member/beads schema.
- Pointing the unit at the binary's own subcommand removes the external node
  dependency entirely: service units do not source shell rc files, so a bare
  `node` would not resolve under nvm/fnm/volta, and under the released binary
  `process.execPath` is the apra-fleet binary rather than `node` anyway.
- `apra-fleet start`, `stop` and `uninstall` cover both services;
  `apra-fleet status` reports them on separate, labelled lines
  (`Service (MCP server):` / `Service (fleet supervisor):`).
- Supervisor registration failure during install is fatal: install aborts with
  a non-zero exit and an explanatory error. The one case that cleanly skips
  registration without failing is `install --workflows none`, since the
  workflow assets that contain the supervisor were never installed; install
  prints an explicit "NOT registered ... --workflows none" message and still
  succeeds.

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
