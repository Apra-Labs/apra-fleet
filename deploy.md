# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes in `.claude/settings.json` under `permissions.allow`:
- `Bash(gh run *)`
- `Bash(gh release *)`
- `Bash(mkdir *)`
- `Bash(*apra-fleet-installer-* install *)`
- `Bash(*apra-fleet-installer-* --version)`

## Prerequisites
- `gh` CLI authenticated with access to Apra-Labs/apra-fleet
- Fleet MCP server accessible (via `/mcp` in Claude Code)

## Deploy

Deploys the latest successful CI build from `main` to this machine's real,
day-to-day `apra-fleet` install (`~/.apra-fleet`). This is NOT the isolated
integration-test sandbox -- see `integ-test-playbook.md` for that.

```bash
mkdir -p /tmp/fleet-deploy
RUN_ID=$(gh run list --repo Apra-Labs/apra-fleet --branch main --workflow "CI - Build & Test" --status success --limit 1 --json databaseId -q '.[0].databaseId')
gh run download "$RUN_ID" --repo Apra-Labs/apra-fleet --name apra-fleet-installer-win-x64.exe --dir /tmp/fleet-deploy
/tmp/fleet-deploy/apra-fleet-installer-win-x64.exe install --force
```

This handles shutdown, binary replacement, skill installation, and restart in one step.

## Smoke test

```bash
~/.apra-fleet/bin/apra-fleet.exe --version
```

Exit 0 = healthy. After a manual deploy, also run `/mcp` in Claude Code to
reconnect, then `fleet_status` to confirm all members are online (not
automatable from this file -- a follow-up human/Claude-Code-session step,
not part of the exit-code smoke test above).

## Manual / ad-hoc deploys

The automated `## Deploy` section above always targets `main`'s latest green
build. To deploy a specific branch or a tagged release instead (e.g. testing
a PR build, or rolling forward to a named release):

```bash
# Latest CI run on a specific branch
gh run list --repo Apra-Labs/apra-fleet --branch <branch> --limit 1

# Or from a release tag
gh release list --repo Apra-Labs/apra-fleet --limit 5
gh release download <tag> --repo Apra-Labs/apra-fleet -p "apra-fleet-installer-win-x64.exe" -D /tmp/fleet-deploy
/tmp/fleet-deploy/apra-fleet-installer-win-x64.exe install --force
```

## Rollback

The installer does not create a backup -- to rollback, download the previous
release and re-run the installer with `--force`:

```bash
# Download previous version (replace <tag> with the version to roll back to, e.g. v0.1.8.1)
gh release download <tag> --repo Apra-Labs/apra-fleet -p "apra-fleet-installer-win-x64.exe" -D /tmp/fleet-rollback

# Re-install
/tmp/fleet-rollback/apra-fleet-installer-win-x64.exe install --force
```

After rollback, run `/mcp` in Claude Code to reconnect, then `fleet_status`
to verify members are online.

## Platform binaries

| Platform | Artifact name |
|----------|--------------|
| Windows x64 | `apra-fleet-installer-win-x64.exe` |
| Linux x64 | `apra-fleet-installer-linux-x64` |
| macOS ARM | `apra-fleet-installer-darwin-arm64` |
