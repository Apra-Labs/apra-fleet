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
cd /tmp/fleet-deploy

# From CI artifact (branch build)
gh run download <run-id> --repo Apra-Labs/apra-fleet -n apra-fleet-installer-win-x64.exe

# Or from release
gh release download <tag> --repo Apra-Labs/apra-fleet -p "apra-fleet-installer-win-x64.exe" -D /tmp/fleet-deploy
```

### 3. Install
```bash
/tmp/fleet-deploy/apra-fleet-installer-win-x64.exe install --skill
```
This handles shutdown, binary replacement, skill installation, and restart in one step.

### 4. Verify
```bash
~/.apra-fleet/bin/apra-fleet.exe --version
```
In Claude Code: run `/mcp` to reconnect, then use `fleet_status` to confirm all members are online.

## Rollback
The installer backs up the previous binary. To rollback:
```bash
cp ~/.apra-fleet/bin/apra-fleet.exe.bak ~/.apra-fleet/bin/apra-fleet.exe
```

## Platform binaries
| Platform | Artifact name |
|----------|--------------|
| Windows x64 | `apra-fleet-installer-win-x64.exe` |
| Linux x64 | `apra-fleet-installer-linux-x64` |
| macOS ARM | `apra-fleet-installer-darwin-arm64` |
