# launch-env-b.ps1 -- foolproof Env B preparation for the Upgrade demo.
#
# Dot-source this (note the leading dot + space) so APRA_FLEET_DATA_DIR
# survives into your shell:
#
#   . C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\launch-env-b.ps1
#
# It fixes the two things that broke the first Env B run:
#   1. asserts the CURRENT build's skills are the active global install
#      (the first run silently used cached v0.3.4 skills), and
#   2. sets APRA_FLEET_DATA_DIR to data-b and pre-builds the gitnexus index
#      (the first run left both undone).
#
# After it finishes with [READY], start a BRAND-NEW Claude session in the
# same shell and run the two sprint prompts. Starting a fresh claude process
# after this script is what guarantees current-build skills are loaded.

$ErrorActionPreference = 'Stop'
$repo    = 'C:\ws_yash\Repos\apra-fleet-main\apra-fleet'
$sandbox = 'C:\ws_yash\demo-upgrade\sandbox-b'
$dataDir = 'C:\ws_yash\demo-upgrade\data-b'
$pmSkill = Join-Path $env:USERPROFILE '.claude\skills\pm'

Write-Host ''
Write-Host '=== Env B pre-flight ===' -ForegroundColor Cyan

# 1. HARD ASSERT: the globally-installed PM skill is the CURRENT build (has KB).
#    v0.3.4's PM skill has no kb_session_prime; the current build's does. If the
#    KB marker is absent, the active install is the old build -- STOP and tell
#    the user exactly how to fix it, rather than silently running v0.3.4 again.
$kbMarker = Select-String -Path (Join-Path $pmSkill '*.md') -Pattern 'kb_session_prime' -List -ErrorAction SilentlyContinue
if (-not $kbMarker) {
  Write-Host '[FAIL] The active global PM skill has no KB layer -- it is the OLD build.' -ForegroundColor Red
  Write-Host '       Reinstall the current build first, then re-run this script:' -ForegroundColor Red
  Write-Host "         node $repo\dist\index.js install --force" -ForegroundColor Yellow
  return
}
Write-Host '[OK] Active global PM skill is the current build (kb_session_prime present).' -ForegroundColor Green

# 2. Re-stage a CLEAN sandbox-b (the first run left partial beads/worktrees).
#    Prune any leftover track worktrees first so the copy is pristine.
Get-ChildItem 'C:\ws_yash\demo-upgrade\sandbox-b-wt' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  git -C $sandbox worktree remove --force $_.FullName 2>$null
}
Write-Host '[..] Re-staging sandbox-b (fresh copy, fresh git, npm ci)...' -ForegroundColor Cyan
& powershell.exe -ExecutionPolicy Bypass -File (Join-Path $repo 'demo\setup-env.ps1') -Env B -Force -SkipInstall
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] staging failed' -ForegroundColor Red; return }

# 3. Isolate the KB for this env (the miss that sent the first run to the
#    'default' slug and captured only 1 entry).
$env:APRA_FLEET_DATA_DIR = $dataDir
Write-Host "[OK] APRA_FLEET_DATA_DIR = $dataDir (this shell)." -ForegroundColor Green

# 4. Pre-build the gitnexus index so code intelligence is live from the first
#    dispatch, regardless of whether /pm init triggers it.
Write-Host '[..] Building gitnexus index in the sandbox...' -ForegroundColor Cyan
Push-Location $sandbox
try {
  npx --yes gitnexus analyze 2>&1 | Select-Object -Last 3
  if (Test-Path (Join-Path $sandbox '.gitnexus\meta.json')) {
    Write-Host '[OK] gitnexus index built (.gitnexus/meta.json present).' -ForegroundColor Green
  } else {
    Write-Host '[WARN] gitnexus index not confirmed -- /pm init will retry it.' -ForegroundColor Yellow
  }
} finally { Pop-Location }

Set-Location $sandbox
Write-Host ''
Write-Host '[READY] Env B is prepared and this shell is isolated.' -ForegroundColor Green
Write-Host 'Now, IN THIS SAME SHELL, start a fresh Claude session:' -ForegroundColor Cyan
Write-Host '    claude --dangerously-skip-permissions' -ForegroundColor White
Write-Host 'Then run, one at a time:' -ForegroundColor Cyan
Write-Host '    /pm init fleet-e2e-toy-env-b' -ForegroundColor White
Write-Host '    (sprint 1 prompt -- note archiving)' -ForegroundColor White
Write-Host '    (sprint 2 prompt -- pagination)' -ForegroundColor White
Write-Host 'The exact sprint prompts are in demo\RUNBOOK.md (identical to Env A).' -ForegroundColor DarkGray
