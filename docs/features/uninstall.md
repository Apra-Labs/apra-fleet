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

The fleet supervisor can be registered with the OS service manager (a user-level service that runs the installed tree). A full uninstall stops, disables and removes that registration before it deletes the workflows runtime; otherwise the service would keep running (or restart) against a tree that no longer exists.

Registrations are found by their known names, not by scanning:

| OS | Registration looked up |
|----|------------------------|
| Linux | systemd user units `fleet-supervisor.service` and `apra-fleet-supervisor.service` |
| macOS | launchd label `com.apra-fleet.supervisor` |
| Windows | scheduled task `ApraFleetSupervisor` |

Ownership rule: a registration is removed only if the command it runs points at the installed tree -- either the installed binary with the `supervisor` argument, or the installed fleet-sprint `serve.mjs`. A registration with the same name that runs something else is left alone and reported under "Kept". Quotes around the executable in older unit files are stripped before matching, so older unit shapes are still recognised.

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

- `data/` (credentials store and member registry)
- `fleet.key`, with a warning to back it up separately because the encrypted data is unreadable without it
- user-authored workflows
- any other leftovers under the fleet base directory
- supervisor registrations that are not ours (see ownership rule above)

The section is printed on real and `--dry-run` runs alike. A partial uninstall (`--skill` or `--llm` scoped) does not print it, since most of the install is intentionally still present.

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
