# Uninstall Command

## Why it exists

Installing for a second provider (`apra-fleet install --llm <other>`) on a machine where only Claude was intended causes a split-brain problem: that provider's CLI sessions spawn a second fleet server process sharing the same `FLEET_DIR`, so `execute_prompt` sessions route to the wrong server instance. Without an uninstall path there is no clean way to reverse an install -- users would have to hand-edit provider config files with no record of what was installed or where.

## Design

### install-config.json as source of truth

At install time, fleet writes `~/.apra-fleet/data/install-config.json` with a keyed-by-provider schema:

```json
{
  "providers": {
    "claude": { "skill": "all" },
    "agy": { "skill": "fleet" }
  }
}
```

`apra-fleet uninstall` (no flags) reads this file and reverses exactly what it recorded. If the file is missing or corrupt, the command falls back to scanning all known provider config paths and warns the user before proceeding.

Multiple installs (e.g. first `--llm claude`, later `--llm agy`) merge into the map rather than overwriting, so the uninstall can target each provider independently.

### Surgical settings cleanup

Uninstall does not rewrite settings files wholesale -- it removes only the keys fleet installed:

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

If the fleet server is running when uninstall is invoked, the command aborts with a clear error suggesting `--force`. With `--force`, the server is stopped automatically before proceeding. With `--dry-run --force`, the server-running state is reported but the server is not actually stopped -- dry-run is purely observational.

### Supervisor service removal

This product line does not register a supervisor OS service itself, but one can be left on a machine by an earlier release's install or by an operator following the fleet-supervisor skill's auto-start recipe. Uninstall deletes the installed workflows/fleet-sprint tree that such a service runs, so a registration left behind would keep a dead (or orphaned, still-running) supervisor across reboots. Uninstall therefore stops, disables and removes the registration before deleting that tree. This runs for the default and `--skill workflows` scopes.

Registrations are found by their known names, not by scanning:

| OS | Registration looked up |
|----|------------------------|
| Linux | systemd user units `fleet-supervisor.service` and `apra-fleet-supervisor.service` |
| macOS | launchd label `com.apra-fleet.supervisor` |
| Windows | scheduled task `ApraFleetSupervisor` |

Ownership rule: a registration is removed only if the command it runs points at the installed tree -- either the installed binary with the `supervisor` argument, or the installed fleet-sprint `serve.mjs`. A known name alone is not proof of ownership: the skill's recipe uses the same macOS and Windows names but points at a development checkout. A registration whose target runs something else, or cannot be read, is left alone and reported (in the Kept section on a full uninstall, or as an inline "Keeping" line otherwise). Quotes around the executable in older unit files are stripped before matching, so older unit shapes are still recognised.

Removal per OS:

- Linux: `systemctl --user disable --now`, delete the unit file, `daemon-reload`.
- macOS: `launchctl bootout` (a plist that is not loaded is tolerated), delete the plist.
- Windows: locate the running process with a PowerShell `-EncodedCommand` query, kill its whole tree, delete the scheduled task, delete the wrapper script.

Invariants:

- All external commands are passed as argument arrays; nothing is built by shell interpolation, because the Windows side may be PowerShell rather than POSIX.
- The cleanup runs before, and independently of, workflows cleanup. A re-run after the tree is already gone still removes a leftover registration.
- A failed removal is named in the output and the command exits 1. It never reports success while a service is left behind.

### Kept (intentionally) section

A full uninstall ends by listing what it deliberately did not remove, so the user can tell "left on purpose" from "missed":

- `data/` (registry, logs and credentials, kept so a reinstall keeps your fleet)
- `fleet.key` (the JWT signing key), with a warning that it lives outside `data/`, so a backup of `data/` alone misses it
- user-authored workflows
- any other leftovers under the fleet base directory
- supervisor registrations that are not ours (see ownership rule above)

The section is printed on real and `--dry-run` runs alike. It is printed only for a full uninstall (`--llm all` and `--skill all`, the defaults). Any narrower scope (`--llm <provider>` or `--skill <name>`) omits it, since most of the install is intentionally still present.

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
