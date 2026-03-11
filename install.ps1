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

# Install PM skill
Write-Host "Installing PM skill..."
$SkillsDir = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
Copy-Item -Recurse -Force "$InstallDir\skills\pm" "$SkillsDir\pm"

Write-Host ""
$NodePath = "$InstallDir\dist\index.js" -replace '\\', '/'
claude mcp add --scope user fleet -- node $NodePath
Write-Host ""
Write-Host "Apra Fleet installed successfully."
Write-Host "  Install dir: $InstallDir"
Write-Host "  PM skill:    $SkillsDir\pm\"
Write-Host ""
Write-Host "Run /mcp in Claude Code to load the server."
