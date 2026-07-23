# demo/setup-env.ps1
#
# Stages one environment (A = released v0.3.4 binary, B = this branch build)
# for the Upgrade demo: a fresh sandbox copy of the NoteAPI toy repo, an
# isolated per-env KB/data directory, and the matching apra-fleet install.
#
# Usage:
#   .\demo\setup-env.ps1 -Env A
#   .\demo\setup-env.ps1 -Env B
#   .\demo\setup-env.ps1 -Env B -Force          # wipe + recreate an existing sandbox
#   .\demo\setup-env.ps1 -Env B -SkipInstall    # stage the sandbox but do NOT run the
#                                                # installer (see NOTE below) -- for dry
#                                                # runs / testing setup-env.ps1 itself,
#                                                # NOT for the real recording.
#
# NOTE ON INSTALL SEMANTICS (verified against src/cli/install.ts and
# src/cli/config.ts in this repo): apra-fleet install is a MACHINE-GLOBAL
# operation, not a per-sandbox one.
#   - PM/fleet skills are written to ~/.claude/skills/pm (config.ts skillsDir
#     for the claude provider) -- a fixed, home-directory path.
#   - The MCP server is registered with `claude mcp add --scope user apra-fleet`
#     -- USER scope, i.e. one registration per machine, not per project.
#   - ~/.claude/CLAUDE.md and ~/.claude/workflows/auto-sprint.js are also
#     home-directory paths.
#   - Only the KB/code-intelligence DATA (kb.sqlite, code-intelligence config)
#     honors APRA_FLEET_DATA_DIR (src/paths.ts FLEET_DIR) -- that part IS
#     per-env isolated by the env-<a|b>.ps1 snippet this script writes.
# CONSEQUENCE: running the Env A installer and then the Env B build's
# installer on the SAME machine will each overwrite the other's global
# skills/MCP registration/CLAUDE.md. This is expected and is why the
# runbook installs immediately before each env's recording segment. If you
# have a real, non-demo apra-fleet setup on this machine, back up
# ~/.claude/skills/pm, ~/.claude/workflows/auto-sprint.js, and the
# apra-fleet block of ~/.claude/CLAUDE.md before recording, and re-run your
# own `apra-fleet install` afterward to restore it. See RUNBOOK.md.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('A', 'B')]
  [string]$Env,

  [switch]$Force,

  # Stages everything except the final apra-fleet install step. Useful for
  # testing this script without touching the machine's global ~/.claude
  # skills/MCP registration. Do NOT use this for the actual recording --
  # the camera-moment callouts (gitnexus index, kb_session_prime, etc.)
  # depend on a real install having run.
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot          # ...\apra-fleet-main\apra-fleet
$ToySource = 'C:\ws_yash\Repos\apra-fleet-main\Workshop\fleet-e2e-toy'
$DemoRoot = 'C:\ws_yash\demo-upgrade'

$EnvLower = $Env.ToLower()
$SandboxDir = Join-Path $DemoRoot ('sandbox-' + $EnvLower)
$DataDir = Join-Path $DemoRoot ('data-' + $EnvLower)
$EnvSnippetPath = Join-Path $DemoRoot ('env-' + $EnvLower + '.ps1')
$InstallerExe = Join-Path $RepoRoot 'demo\downloads\apra-fleet-installer-win-x64.exe'
$DistIndex = Join-Path $RepoRoot 'dist\index.js'

# ---------------------------------------------------------------------------
# Safety checks (constraints: never clobber silently, never target this repo
# or its worktree as "a sandbox").
# ---------------------------------------------------------------------------

function Resolve-FullPathSafe([string]$p) {
  if (Test-Path $p) { return (Resolve-Path $p).Path }
  return $p
}

$resolvedSandbox = Resolve-FullPathSafe $SandboxDir
$resolvedRepoRoot = Resolve-FullPathSafe $RepoRoot
$resolvedToySource = Resolve-FullPathSafe $ToySource

if ($resolvedSandbox -ieq $resolvedRepoRoot) {
  throw "Refusing to use $RepoRoot itself as a sandbox. This must never happen."
}
if (-not (Test-Path $ToySource)) {
  throw "Toy source repo not found at $ToySource. Expected the fleet-e2e-toy worktree there."
}

if (Test-Path $SandboxDir) {
  if (-not $Force) {
    Write-Host ''
    Write-Host "REFUSING TO CONTINUE: $SandboxDir already exists." -ForegroundColor Red
    Write-Host "Re-run with -Force to wipe and recreate it, e.g.:" -ForegroundColor Yellow
    Write-Host "  .\demo\setup-env.ps1 -Env $Env -Force" -ForegroundColor Yellow
    Write-Host ''
    exit 1
  }
  Write-Host "Force: removing existing $SandboxDir ..." -ForegroundColor Yellow
  Remove-Item -Recurse -Force $SandboxDir
}
if (Test-Path $DataDir) {
  if (-not $Force) {
    Write-Host ''
    Write-Host "REFUSING TO CONTINUE: $DataDir already exists." -ForegroundColor Red
    Write-Host "Re-run with -Force to wipe and recreate it." -ForegroundColor Yellow
    Write-Host ''
    exit 1
  }
  Write-Host "Force: removing existing $DataDir ..." -ForegroundColor Yellow
  Remove-Item -Recurse -Force $DataDir
}

New-Item -ItemType Directory -Force -Path $DemoRoot | Out-Null
New-Item -ItemType Directory -Force -Path $SandboxDir | Out-Null
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

# ---------------------------------------------------------------------------
# Copy the toy repo, excluding .git/node_modules/any code-intelligence state/
# the toy repo's own committed installer exe.
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host "[1/5] Copying $ToySource -> $SandboxDir (excluding .git, node_modules, .fleet, .gitnexus, .beads, installer exes) ..." -ForegroundColor Cyan

$robocopyArgs = @(
  $ToySource, $SandboxDir,
  '/E',
  '/XD', '.git', 'node_modules', '.fleet', '.gitnexus', '.beads',
  '/XF', 'apra-fleet-installer.exe', 'apra-fleet-installer-win-x64.exe',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'
)
robocopy @robocopyArgs | Out-Null
# robocopy exit codes 0-7 are all "success" variants; >=8 is a real error.
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

# ---------------------------------------------------------------------------
# Fresh git history for the sandbox copy.
# ---------------------------------------------------------------------------

Write-Host "[2/5] Initializing fresh git history in $SandboxDir ..." -ForegroundColor Cyan
Push-Location $SandboxDir
try {
  git init -q
  git add -A
  git -c user.name='demo-upgrade' -c user.email='demo-upgrade@local' commit -q -m "chore: fresh sandbox copy of fleet-e2e-toy for Env $Env"
} finally {
  Pop-Location
}

# ---------------------------------------------------------------------------
# npm ci in the sandbox, if there's a package.json.
# ---------------------------------------------------------------------------

if (Test-Path (Join-Path $SandboxDir 'package.json')) {
  Write-Host "[3/5] Running npm ci in $SandboxDir ..." -ForegroundColor Cyan
  Push-Location $SandboxDir
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[3/5] No package.json in sandbox -- skipping npm ci." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Per-env data dir snippet (env var isolation -- KB/code-intelligence data only;
# see the NOTE at the top of this file about what is NOT isolated).
# ---------------------------------------------------------------------------

Write-Host "[4/5] Writing $EnvSnippetPath ..." -ForegroundColor Cyan
$snippet = @"
# Dot-source this in the PowerShell session you will run the Claude CLI from,
# BEFORE starting the sprint for Env ${Env}:
#   . $EnvSnippetPath
`$env:APRA_FLEET_DATA_DIR = '$DataDir'
Write-Host "APRA_FLEET_DATA_DIR set to `$env:APRA_FLEET_DATA_DIR (Env $Env) for this shell session."
"@
Set-Content -Path $EnvSnippetPath -Value $snippet -Encoding ascii

# ---------------------------------------------------------------------------
# Install (Env-specific). Runs with the SANDBOX as the working directory so
# any repo-cwd-relative setup (KB data, .mcp.json, gitnexus binding) attaches
# to the sandbox repo, not to this apra-fleet checkout.
# ---------------------------------------------------------------------------

Write-Host "[5/5] Install step for Env $Env ..." -ForegroundColor Cyan

if ($SkipInstall) {
  Write-Host "  -SkipInstall passed: NOT running the installer. Sandbox is staged only." -ForegroundColor Yellow
} elseif ($Env -eq 'A') {
  if (-not (Test-Path $InstallerExe)) {
    throw "Installer not found at $InstallerExe. Download it first (on camera per RUNBOOK.md):`n  gh release download v0.3.4 --repo Apra-Labs/apra-fleet --pattern apra-fleet-installer-win-x64.exe --dir demo\downloads"
  }
  Write-Host "  Running $InstallerExe from $SandboxDir (install is the default action, v0.3.3+) ..." -ForegroundColor Cyan
  Push-Location $SandboxDir
  try {
    & $InstallerExe
    if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} else {
  if (-not (Test-Path $DistIndex)) {
    throw "Build not found at $DistIndex. Run 'npm ci; npm run build' in $RepoRoot first (on camera per RUNBOOK.md)."
  }
  Write-Host "  Running node $DistIndex install from $SandboxDir ..." -ForegroundColor Cyan
  Push-Location $SandboxDir
  try {
    node $DistIndex install
    if ($LASTEXITCODE -ne 0) { throw "install exited with code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------------------
# Next steps.
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host "Env $Env staged." -ForegroundColor Green
Write-Host "  Sandbox:  $SandboxDir"
Write-Host "  Data dir: $DataDir"
Write-Host "  Env snippet: $EnvSnippetPath"
Write-Host ''
Write-Host "Next steps:" -ForegroundColor Green
Write-Host "  1. In the terminal you'll run your Claude session from:"
Write-Host "       . $EnvSnippetPath"
Write-Host "  2. cd $SandboxDir"
Write-Host "  3. Start Claude Code, run /pm init, then the sprint 1 prompt, then /pm start."
Write-Host "  4. After sprint 1: node `"$RepoRoot\demo\collect-metrics.mjs`" $Env sprint1"
Write-Host "  5. Run the sprint 2 prompt, then /pm start."
Write-Host "  6. After sprint 2: node `"$RepoRoot\demo\collect-metrics.mjs`" $Env sprint2"
if ($Env -eq 'A') {
  Write-Host ''
  Write-Host "  When you move on to Env B: .\demo\setup-env.ps1 -Env B" -ForegroundColor Yellow
  Write-Host "  will re-run the installer and OVERWRITE the global ~/.claude skills/MCP" -ForegroundColor Yellow
  Write-Host "  registration this step just wrote (see NOTE at top of this script)." -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host "  Once both envs are collected: node `"$RepoRoot\demo\gain-report.mjs`"" -ForegroundColor Yellow
}
Write-Host ''
