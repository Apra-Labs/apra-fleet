$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.claude-fleet-mcp"
$RepoUrl = "https://github.com/Apra-Labs/claude-code-fleet-mcp.git"

Write-Host "Installing Claude Code Fleet MCP..."

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
Write-Host "Build complete."
Write-Host ""

$NodePath = "$InstallDir\dist\index.js" -replace '\\', '/'
$Auto = $args -contains "--auto" -or $args -contains "-Auto"

if ($Auto) {
    claude mcp add --scope user fleet -- node $NodePath
    Write-Host "Registered fleet MCP server for your user."
} else {
    Write-Host "Run this to register the MCP server:"
    Write-Host ""
    Write-Host "  claude mcp add --scope user fleet -- node $NodePath"
    Write-Host ""
    Write-Host "Or re-run with -Auto to do it automatically:"
    Write-Host "  powershell -File $InstallDir\install.ps1 -Auto"
}

Write-Host ""
Write-Host "Then run /mcp in Claude Code to load the server."
