# Fresh-install harness: Windows Sandbox driver for ONE pass.
# Generates a .wsb (box scripts, candidate dir and cache mapped read-only, out
# writable, networking on), launches it, polls <OutDir>\done.txt, then closes
# the sandbox processes it started. Never touches the host's own install.
# Exit: 0 = box finished (verdicts are applied by run.mjs), 2 = driver error.
param(
  [Parameter(Mandatory = $true)][string]$Pass,
  [Parameter(Mandatory = $true)][string]$BoxDir,
  [Parameter(Mandatory = $true)][string]$CandPath,
  [Parameter(Mandatory = $true)][string]$CacheDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$BaseRel = '',
  [string]$NodeRel = '',
  [string]$NodeSha = '',
  [int]$TimeoutMin = 45,
  [int]$MemoryMB = 6144
)
$ErrorActionPreference = 'Stop'
$names = @('WindowsSandbox', 'WindowsSandboxClient', 'WindowsSandboxRemoteSession')
function SandboxProcs { Get-Process -Name $names -ErrorAction SilentlyContinue }

$exe = Join-Path $env:SystemRoot 'System32\WindowsSandbox.exe'
if (-not (Test-Path $exe)) { Write-Output "DRIVER-ERROR: Windows Sandbox is not enabled (missing $exe)"; exit 2 }
if (SandboxProcs) { Write-Output 'DRIVER-ERROR: a Windows Sandbox is already running; only one can run at a time. Close it and retry.'; exit 2 }

New-Item -ItemType Directory -Force $OutDir | Out-Null
Get-ChildItem $OutDir -Force | Remove-Item -Recurse -Force
$candDir = Split-Path -Parent (Resolve-Path $CandPath)
$candLeaf = Split-Path -Leaf $CandPath
$runDir = Split-Path -Parent $OutDir
$wsb = Join-Path $runDir "sandbox-$Pass.wsb"

$logon = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\fi\in\pass.ps1 -Pass $Pass -Cand C:\fi\cand\$candLeaf -Out C:\fi\out"
if ($BaseRel) { $logon += " -Base C:\fi\cache\$BaseRel" }
if ($NodeRel) { $logon += " -NodeMsi C:\fi\cache\$NodeRel -NodeSha $NodeSha" }
function Esc($s) { [Security.SecurityElement]::Escape($s) }
$xml = @"
<Configuration>
  <Networking>Enable</Networking>
  <MemoryInMB>$MemoryMB</MemoryInMB>
  <MappedFolders>
    <MappedFolder><HostFolder>$(Esc (Resolve-Path $BoxDir))</HostFolder><SandboxFolder>C:\fi\in</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Esc $candDir)</HostFolder><SandboxFolder>C:\fi\cand</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Esc (Resolve-Path $CacheDir))</HostFolder><SandboxFolder>C:\fi\cache</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>$(Esc (Resolve-Path $OutDir))</HostFolder><SandboxFolder>C:\fi\out</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>$(Esc $logon)</Command></LogonCommand>
</Configuration>
"@
[IO.File]::WriteAllText($wsb, $xml, (New-Object Text.UTF8Encoding($false)))
Write-Output "pass $Pass wsb: $wsb"

$started = $null
for ($try = 1; $try -le 2 -and -not $started; $try++) {
  try { $started = Start-Process -FilePath $wsb -PassThru } catch {
    Write-Output "launch attempt $try failed: $($_.Exception.Message)"
    if ($try -eq 2) { Write-Output 'DRIVER-ERROR: could not launch Windows Sandbox'; exit 2 }
    Start-Sleep 10
  }
}
$done = Join-Path $OutDir 'done.txt'
$deadline = (Get-Date).AddMinutes($TimeoutMin)
$seenProc = $false
while ((Get-Date) -lt $deadline -and -not (Test-Path $done)) {
  Start-Sleep 10
  if (SandboxProcs) { $seenProc = $true } elseif ($seenProc) { break }
}
$rc = 0
if (Test-Path $done) { Write-Output "pass $Pass box finished: $(Get-Content $done)" }
elseif ($seenProc -and -not (SandboxProcs)) { Write-Output "DRIVER-ERROR: sandbox closed before the box finished"; $rc = 2 }
else { Write-Output "DRIVER-ERROR: timed out after $TimeoutMin min waiting for done.txt"; $rc = 2 }

# Close the sandbox we started (only one can exist, so every sandbox process is ours).
Start-Sleep 3
SandboxProcs | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 30 -and (SandboxProcs); $i++) { Start-Sleep 2 }
if (SandboxProcs) { Write-Output 'WARNING: sandbox processes still present after close' }
exit $rc
