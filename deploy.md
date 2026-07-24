# Fleet Deploy Runbook

## Permissions

### Claude Code

Commands below require these prefixes in `.claude/settings.json` under `permissions.allow`:
- `Bash(gh run *)`
- `Bash(gh release *)`
- `Bash(mkdir *)`
- `Bash(rm -rf /tmp/fleet-deploy*)`
- `Bash(chmod +x /tmp/fleet-deploy*)`
- `Bash(*apra-fleet-installer-* install *)`
- `Bash(*apra-fleet* --version)`
- `Bash(npm ci)`
- `Bash(npm run build)`
- `Bash(npm run build:binary)`
- `Bash(dist/apra-fleet-installer-* install *)`

### Antigravity (AGY)

Commands below require `command` permission grants in Antigravity (or explicit user approval when prompted):
- `gh`
- `mkdir`
- `rm`
- `chmod`
- `npm`
- `*apra-fleet-installer-*`
- `*apra-fleet*`

## Prerequisites
- `gh` CLI authenticated with access to Apra-Labs/apra-fleet
- Fleet MCP server accessible (via `/mcp` in Claude Code)

## Deploy

Deploys the latest successful CI build from `main` to this machine's real,
day-to-day `apra-fleet` install (`~/.apra-fleet`). This is NOT the isolated
integration-test sandbox -- see `integ-test-playbook.md` for that.

The runbook is platform-agnostic: pick the artifact for the OS+architecture
this runbook is executing on (see the Platform binaries table at the
bottom), and clean the work dir first so re-runs never collide with a
previous download. CI only publishes `win-x64`, `linux-x64`, and
`darwin-arm64` artifacts -- a host OS+arch combination with no matching
prebuilt artifact (notably Darwin+x86_64, i.e. an Intel Mac) has no artifact
to download, so it falls back to building the installer from source in this
repo checkout instead.

```bash
OS="$(uname -s)"
ARCH="$(uname -m)"
FALLBACK_BUILD=false
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  ARTIFACT=apra-fleet-installer-darwin-arm64 ;;
      *)      FALLBACK_BUILD=true ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) ARTIFACT=apra-fleet-installer-linux-x64 ;;
      *)      FALLBACK_BUILD=true ;;
    esac
    ;;
  *)
    # Windows (and any other uname -s value): only a win-x64 artifact is
    # published, regardless of reported architecture.
    ARTIFACT=apra-fleet-installer-win-x64.exe
    ;;
esac

if [ "$FALLBACK_BUILD" = true ]; then
  # No prebuilt CI artifact for this OS+arch (e.g. Darwin+x86_64 / Intel
  # Mac) -- build the installer from source instead. npm ci gives a clean,
  # idempotent install on every re-run; build:binary always overwrites its
  # dist/ output, so this is safe to run repeatedly.
  npm ci
  npm run build
  npm run build:binary
  SEA_ARCH="$ARCH"
  case "$SEA_ARCH" in
    x86_64) SEA_ARCH=x64 ;;
  esac
  SEA_PLATFORM="$(echo "$OS" | tr '[:upper:]' '[:lower:]')"
  BUILT_INSTALLER="dist/apra-fleet-installer-${SEA_PLATFORM}-${SEA_ARCH}"
  "$BUILT_INSTALLER" install --force --llm <claude|agy>
else
  rm -rf /tmp/fleet-deploy
  mkdir -p /tmp/fleet-deploy
  RUN_ID=$(gh run list --repo Apra-Labs/apra-fleet --branch main --workflow "CI - Build & Test" --status success --limit 1 --json databaseId -q '.[0].databaseId')
  gh run download "$RUN_ID" --repo Apra-Labs/apra-fleet --name "$ARTIFACT" --dir /tmp/fleet-deploy
  chmod +x "/tmp/fleet-deploy/$ARTIFACT"
  "/tmp/fleet-deploy/$ARTIFACT" install --force --llm <claude|agy>
fi
```

This handles shutdown, binary replacement, skill installation, and restart in
one step. On prebuilt-artifact platforms (win-x64, linux-x64, darwin-arm64)
behaviour is unchanged from before; only the no-matching-artifact case (e.g.
Darwin+x86_64) takes the source-build fallback path.

## Smoke test

The installed binary is `apra-fleet.exe` on Windows and `apra-fleet` elsewhere:

```bash
"$HOME/.apra-fleet/bin/apra-fleet" --version || "$HOME/.apra-fleet/bin/apra-fleet.exe" --version
```

Exit 0 = healthy. After a manual deploy, also run `/mcp` in Claude Code to
reconnect, then `fleet_status` to confirm all members are online (not
automatable from this file -- a follow-up human/Claude-Code-session step,
not part of the exit-code smoke test above).

## Manual / ad-hoc deploys

The automated `## Deploy` section above always targets `main`'s latest green
build. To deploy a specific branch or a tagged release instead (e.g. testing
a PR build, or rolling forward to a named release), substitute the artifact
name for your platform from the table below:

```bash
# Latest CI run on a specific branch
gh run list --repo Apra-Labs/apra-fleet --branch <branch> --limit 1

# Or from a release tag
gh release list --repo Apra-Labs/apra-fleet --limit 5
rm -rf /tmp/fleet-deploy && mkdir -p /tmp/fleet-deploy
gh release download <tag> --repo Apra-Labs/apra-fleet -p "<artifact-for-this-platform>" -D /tmp/fleet-deploy
chmod +x /tmp/fleet-deploy/<artifact-for-this-platform>
/tmp/fleet-deploy/<artifact-for-this-platform> install --force --llm <claude|agy>
```

## Rollback

The installer does not create a backup -- to rollback, download the previous
release and re-run the installer with `--force`:

```bash
# Download previous version (replace <tag> with the version to roll back to,
# e.g. v0.1.8.1, and <artifact-for-this-platform> from the table below)
rm -rf /tmp/fleet-rollback
gh release download <tag> --repo Apra-Labs/apra-fleet -p "<artifact-for-this-platform>" -D /tmp/fleet-rollback
chmod +x /tmp/fleet-rollback/<artifact-for-this-platform>
/tmp/fleet-rollback/<artifact-for-this-platform> install --force --llm <claude|agy>
```

After rollback, run `/mcp` in Claude Code to reconnect, then `fleet_status`
to verify members are online.

## Platform binaries

| Platform | Artifact name |
|----------|--------------|
| Windows x64 | `apra-fleet-installer-win-x64.exe` |
| Linux x64 | `apra-fleet-installer-linux-x64` |
| macOS ARM | `apra-fleet-installer-darwin-arm64` |
| macOS Intel (darwin-x64) | No prebuilt CI artifact -- build from source (`npm ci && npm run build && npm run build:binary`), then run the resulting `dist/apra-fleet-installer-darwin-x64` |
