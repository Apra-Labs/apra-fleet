$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.apra-fleet"
$RepoUrl = "https://github.com/Apra-Labs/apra-fleet.git"

Write-Host "Installing Apra Fleet..."

if (Test-Path $InstallDir) {
    Write-Host "Updating existing installation at $InstallDir"
    git -C $InstallDir pull --ff-only
} else {
    Write-Host "Cloning to $InstallDir"
    git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir
npm install --no-fund --no-audit
npm run build

Write-Host ""
$NodePath = "$InstallDir\dist\index.js" -replace '\\', '/'
claude mcp add --scope user fleet -- node $NodePath
Write-Host ""
Write-Host "Done. Run /mcp in Claude Code to load the server."
