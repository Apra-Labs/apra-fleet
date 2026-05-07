# Fleet Deploy Runbook
IMP: Must be run using model tier `cheap`
## Prerequisites
- `gh` CLI authenticated with access to Apra-Labs/apra-fleet
- Fleet MCP server accessible (via `/mcp` in Claude Code)

## Steps

### 1. Identify the build
```bash
# Latest CI run on a branch
gh run list --repo Apra-Labs/apra-fleet --branch <branch> --limit 1

# Or from a release tag
gh release list --repo Apra-Labs/apra-fleet --limit 5
```

### 2. Download the binary
```bash
mkdir -p /tmp/fleet-deploy

# From CI artifact (branch build) — gh run download creates a subdirectory per artifact
gh run download <run-id> --repo Apra-Labs/apra-fleet --dir /tmp/fleet-deploy

# Or from release (downloads the file directly, no subdirectory)
gh release download <tag> --repo Apra-Labs/apra-fleet -p "apra-fleet-installer-win-x64.exe" -D /tmp/fleet-deploy
```

### 3. Install
```bash
# CI artifact: file is inside a subdirectory named after the artifact
/tmp/fleet-deploy/apra-fleet-installer-win-x64.exe/apra-fleet-installer-win-x64.exe install --force

# Release download: file is directly in the target dir
/tmp/fleet-deploy/apra-fleet-installer-win-x64.exe install --force
```
This handles shutdown, binary replacement, skill installation, and restart in one step.

### 4. Verify
```bash
~/.apra-fleet/bin/apra-fleet.exe --version
```
In Claude Code: run `/mcp` to reconnect, then use `fleet_status` to confirm all members are online.

## Rollback
The installer does not create a backup — to rollback, download the previous release and re-run the installer with `--force`:

```bash
# Download previous version (replace <tag> with the version to roll back to, e.g. v0.1.8.1)
gh release download <tag> --repo Apra-Labs/apra-fleet -p "apra-fleet-installer-win-x64.exe" -D /tmp/fleet-rollback

# Re-install
/tmp/fleet-rollback/apra-fleet-installer-win-x64.exe install --force
```

After rollback, run `/mcp` in Claude Code to reconnect, then `fleet_status` to verify members are online.

## Platform binaries
| Platform | Artifact name |
|----------|--------------|
| Windows x64 | `apra-fleet-installer-win-x64.exe` |
| Linux x64 | `apra-fleet-installer-linux-x64` |
| macOS ARM | `apra-fleet-installer-darwin-arm64` |
