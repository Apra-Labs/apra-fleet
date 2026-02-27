$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\.claude-fleet-mcp"
$SettingsFile = "$env:USERPROFILE\.claude\settings.json"
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

$NodeArgs = "$InstallDir\dist\index.js" -replace '\\', '/'
$McpEntry = @"
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["$NodeArgs"]
    }
  }
}
"@

$Auto = $args -contains "--auto" -or $args -contains "-Auto"

if ($Auto) {
    $SettingsDir = Split-Path $SettingsFile
    if (-not (Test-Path $SettingsDir)) {
        New-Item -ItemType Directory -Path $SettingsDir -Force | Out-Null
    }
    if (Test-Path $SettingsFile) {
        $Settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json
        if (-not $Settings.mcpServers) {
            $Settings | Add-Member -NotePropertyName "mcpServers" -NotePropertyValue ([PSCustomObject]@{})
        }
        $FleetEntry = [PSCustomObject]@{
            command = "node"
            args = @($NodeArgs)
        }
        if ($Settings.mcpServers.fleet) {
            $Settings.mcpServers.fleet = $FleetEntry
        } else {
            $Settings.mcpServers | Add-Member -NotePropertyName "fleet" -NotePropertyValue $FleetEntry
        }
        $Settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
        Write-Host "Updated $SettingsFile with fleet MCP server entry."
    } else {
        $McpEntry | Set-Content $SettingsFile -Encoding UTF8
        Write-Host "Created $SettingsFile with fleet MCP server entry."
    }
} else {
    Write-Host "Add this to $SettingsFile`:"
    Write-Host ""
    Write-Host $McpEntry
    Write-Host ""
    Write-Host "Or re-run with -Auto to do it automatically:"
    Write-Host "  powershell -File $InstallDir\install.ps1 -Auto"
}

Write-Host ""
Write-Host "Then run /mcp in Claude Code to load the server."
