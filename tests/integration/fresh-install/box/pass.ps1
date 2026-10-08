# Fresh-install harness: in-sandbox pass script (Windows dialect).
# Runs as the Windows Sandbox logon command. Records one JSON line per
# checklist step to <Out>\results.jsonl and never aborts on a failed step --
# verdicts are applied on the host (lib/verdict.mjs + checklist.json).
param(
  [Parameter(Mandatory = $true)][string]$Pass,
  [Parameter(Mandatory = $true)][string]$Cand,
  [string]$Base = '',
  [string]$NodeMsi = '',
  [string]$NodeSha = '',
  [string]$Out = 'C:\fi\out',
  [string]$Work = 'C:\fi\work'
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Logs = Join-Path $Out 'logs'; $Shots = Join-Path $Out 'shots'
New-Item -ItemType Directory -Force $Logs, $Shots | Out-Null
$Res = Join-Path $Out 'results.jsonl'
New-Item -ItemType Directory -Force $Work | Out-Null
$FleetHome = Join-Path $env:USERPROFILE '.apra-fleet'
$AF = Join-Path $FleetHome 'bin\apra-fleet.exe'
$BaseUrl = 'http://127.0.0.1:7523'
$Utf8 = New-Object Text.UTF8Encoding($false)

function Log($m) { [IO.File]::AppendAllText((Join-Path $Out 'box.log'), "[$(Get-Date -Format HH:mm:ss)] $m`r`n", $Utf8) }
function Ascii($s) { if ($null -eq $s) { return '' }; return ([string]$s -replace '[^\t\x20-\x7e]', '') }
function Rec($id, $cmd, $exit, $keyline, $observed = '', $na = $null) {
  $o = [ordered]@{ pass = $Pass; id = $id; cmd = (Ascii $cmd); exit = (Ascii "$exit"); keyline = (Ascii $keyline); observed = (Ascii $observed) }
  if ($na) { $o.na = (Ascii $na) }
  [IO.File]::AppendAllText($Res, (($o | ConvertTo-Json -Compress) + "`n"), $Utf8)
  Log "$id exit=$exit key=$keyline obs=$observed $(if ($na) { "NA=$na" })"
}
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Quote($a) { if ($a -match '[\s"]' -or $a -eq '') { return '"' + ($a -replace '"', '\"') + '"' }; return $a }

# Run a process with UTF-8 stdout+stderr captured to a log (PS 5.1 redirection
# would write UTF-16). Sets $script:RC and $script:LOG.
function Run($id, $name, $exe, [string[]]$argv = @(), $stdin = $null, $timeoutSec = 900) {
  $script:LOG = Join-Path $Logs "$id-$name.log"
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = ($argv | ForEach-Object { Quote $_ }) -join ' '
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $text = ''
  try {
    $p = [Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    if ($null -ne $stdin) { $p.StandardInput.Write($stdin) }
    $p.StandardInput.Close()
    if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch {}; $script:RC = "ERR timeout after ${timeoutSec}s" } else { $script:RC = $p.ExitCode }
    # A child that inherited the pipes (e.g. a detached server) can hold them open.
    if ([Threading.Tasks.Task]::WaitAll(@($o, $e), 30000)) { $text = $o.Result + $e.Result } else { $text = '(output still held open by a child process after exit)' }
  } catch { $script:RC = "ERR $($_.Exception.Message)"; $text = "$_" }
  [IO.File]::WriteAllText($script:LOG, "$text`r`n=== EXIT CODE: $($script:RC) ===`r`n", $Utf8)
}
function Key($file, [string[]]$patterns) {
  $lines = @(Get-Content -LiteralPath $file -Encoding UTF8 -ErrorAction SilentlyContinue)
  foreach ($p in $patterns) { $m = $lines | Where-Object { $_ -match $p } | Select-Object -First 1; if ($m) { return $m.Trim() } }
  $last = $lines | Where-Object { $_.Trim() -ne '' -and $_ -notmatch '^=== EXIT CODE' } | Select-Object -Last 1
  if ($last) { return $last.Trim() } else { return '' }
}
function VerOf($file) {
  $t = Get-Content -LiteralPath $file -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($t -match 'v\d+\.\d+\.\d+_[0-9a-f]+') { return $Matches[0] } else { return '' }
}
function Head($file, $n = 200) {
  $t = Get-Content -LiteralPath $file -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if (-not $t) { return '' }; $t = $t -replace '\s+', ' '; return $t.Substring(0, [Math]::Min($n, $t.Length))
}
# curl.exe ships with Windows 10 1803+; same semantics as the Linux dialect.
function Http($method, $path, [string[]]$extra = @()) {
  $script:BODY = Join-Path $Logs ("http-" + (($method + $path) -replace '[^A-Za-z0-9]', '_') + '.body')
  $a = @('-s', '-o', $script:BODY, '-w', '%{http_code}', '--max-time', '15', '-X', $method) + $extra + @("$BaseUrl$path")
  $code = (& curl.exe @a 2>$null | Out-String).Trim()
  if (-not $code -or $code -eq '000') { $code = 'ERR connection failed' }
  $script:CODE = $code
}
function HealthOk { (& curl.exe -s -o NUL -w '%{http_code}' --max-time 3 "$BaseUrl/health" 2>$null) -eq '200' }
function WaitHealth($secs) { for ($i = 0; $i -lt $secs; $i += 2) { if (HealthOk) { return $true }; Start-Sleep 2 }; return $false }
function HealthStep($id, $wait = 90) {
  WaitHealth $wait | Out-Null
  Http GET /health
  Rec $id 'GET /health' $script:CODE (Head $script:BODY) (VerOf $script:BODY)
  Shot "$id-health" "$BaseUrl/health"
}
function Shot($name, $url) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) { return }
  $png = Join-Path $Shots "$Pass-$name.png"
  try {
    $p = Start-Process -FilePath $edge -PassThru -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', "--user-data-dir=$(Join-Path $Work 'edgeprof')", '--virtual-time-budget=5000', '--window-size=1280,800', "--screenshot=$png", $url
    if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch {} }
  } catch { Log "screenshot $name failed: $_" }
}
function TaskStep($id, $task) {
  Run $id "task-$task" 'schtasks.exe' @('/query', '/tn', $task, '/fo', 'CSV', '/nh')
  Rec $id "schtasks /query /tn $task" $script:RC (Key $script:LOG @($task))
}
function InstallNode($id) {
  $got = (Get-FileHash -Algorithm SHA256 $NodeMsi).Hash.ToLower()
  if ($got -ne $NodeSha.ToLower()) { Rec $id "verify $NodeMsi" 1 "sha256 mismatch: $got"; return }
  $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$NodeMsi`"", '/qn', '/norestart', '/l*v', "`"$(Join-Path $Logs "$id-node-msi.log")`"" -Wait -PassThru
  RefreshPath
  $v = (& node -v 2>&1 | Out-String).Trim()
  Rec $id "msiexec /i $(Split-Path $NodeMsi -Leaf) /qn; node -v" $p.ExitCode "msiexec exit $($p.ExitCode); node $v; sha256 ok" $v
}
function MemberHasDummy { $f = Join-Path $FleetHome 'data\registry.json'; (Test-Path $f) -and ((Get-Content $f -Raw) -match 'fi-dummy') }
function SecretHasDummy { Run 'x' 'secret-list' $AF @('secret', '--list'); (Get-Content $script:LOG -Raw) -match 'fi_dummy_secret' }
function FleetKeyHash { $f = Join-Path $FleetHome 'fleet.key'; if (Test-Path $f) { (Get-FileHash -Algorithm SHA256 $f).Hash.Substring(0, 16).ToLower() } else { 'absent' } }
function YesNo($b) { if ($b) { 'yes' } else { 'no' } }
function Seed($id) {
  New-Item -ItemType Directory -Force (Join-Path $Work 'fi-work') | Out-Null
  Run $id 'register-member' $AF @('register-member', '--name', 'fi-dummy', '--type', 'local', '--path', (Join-Path $Work 'fi-work'), '--llm', 'none')
  $script:SeedMemberRC = $script:RC; $script:SeedMemberLog = $script:LOG
  # Value on stdin with -y (non-interactive); the value is never recorded.
  Run "$id" 'secret-set' $AF @('secret', '--set', 'fi_dummy_secret', '--persist', '-y') 'fi-dummy-value-not-a-real-credential'
  $script:SeedSecretRC = $script:RC; $script:SeedSecretLog = $script:LOG
}
# Replays what 'apra-fleet update' spawns: install --force --llm <p> --skill <s> --workflows <w>
function UpdateArgv {
  $llm = 'claude'; $skill = 'all'; $wf = 'all'
  try {
    $cfg = Get-Content (Join-Path $FleetHome 'data\install-config.json') -Raw | ConvertFrom-Json
    $first = @($cfg.providers.PSObject.Properties)[0]
    if ($first) { $llm = $first.Name; if ($first.Value.skill) { $skill = $first.Value.skill }; if ($first.Value.workflowsMode) { $wf = $first.Value.workflowsMode } }
  } catch { Log "install-config.json unreadable: $_" }
  return @('install', '--force', '--llm', $llm, '--skill', $skill, '--workflows', $wf)
}
function Ok($rc) { return "$rc" -eq '0' }

try {
  [IO.File]::WriteAllText($Res, '', $Utf8)
  Log "pass $Pass start; whoami=$(whoami)"
  $CandExe = Join-Path $Work 'cand.exe'; Copy-Item $Cand $CandExe -Force
  if ($Base) { $BaseExe = Join-Path $Work 'base.exe'; Copy-Item $Base $BaseExe -Force }

  switch ($Pass) {
    'A' {
      Run A01 version $CandExe @('--version'); Rec A01 'cand --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      $w = (& where.exe node 2>$null | Out-String).Trim(); $rc = $LASTEXITCODE; if (-not $w) { $w = 'node not on PATH' }; Rec A02 'where node' $rc $w
      Run A03 install-default $CandExe @('install'); Rec A03 'cand install' $RC (Key $LOG @('fleet-se requires', '^Error'))
      if (Test-Path $FleetHome) { Rec A04 'Test-Path ~\.apra-fleet' 1 ("present: " + ((Get-ChildItem $FleetHome -Force | ForEach-Object Name) -join ' ')) } else { Rec A04 'Test-Path ~\.apra-fleet' 0 '~\.apra-fleet absent' }
      Run A05 install-none $CandExe @('install', '--workflows', 'none'); Rec A05 'cand install --workflows none' $RC (Key $LOG @('installed successfully', '^Error'))
      TaskStep A06 ApraFleet
      HealthStep A07
      Http GET /ui; $k = if ((Get-Content $BODY -Raw -ErrorAction SilentlyContinue) -match 'id="root"') { 'id="root"' } else { Head $BODY 120 }; Rec A08 'GET /ui' $CODE $k
      if ($CODE -eq '200') { Shot 'A08-ui' "$BaseUrl/ui" }
      Http GET /api/fleet/members; Rec A09 'GET /api/fleet/members (no credential)' $CODE (Head $BODY 160)
      Run A10 status $AF @('status'); Rec A10 'apra-fleet status' $RC (Key $LOG @('State:'))
    }
    'B' {
      Run B01 version $CandExe @('--version'); Rec B01 'cand --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      InstallNode B02
      $v = (& npm -v 2>&1 | Out-String).Trim(); Rec B03 'npm -v' $LASTEXITCODE "npm $v"
      Run B04 install $CandExe @('install'); $InstallLog = $LOG; Rec B04 'cand install' $RC (Key $LOG @('installed successfully', '^Error'))
      RefreshPath
      Run B05 bd 'cmd.exe' @('/c', 'bd', 'version'); Rec B05 'bd version' $RC (Key $LOG @('bd version'))
      TaskStep B06 ApraFleet
      if ((Get-Content $InstallLog -Raw) -match 'Supervisor:') { TaskStep B07 ApraFleetSupervisor } else { Rec B07 'install summary: Supervisor line' '' '' '' "this build's installer reports no supervisor service" }
      HealthStep B08
      $init = Join-Path $Work 'init.json'
      [IO.File]::WriteAllText($init, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fresh-install-harness","version":"1"}}}', $Utf8)
      $h = @('-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream', '--data-binary', "@$init")
      # /mcp requires this install's access secret (owner-only member-access.key in the data dir).
      $keyFile = Join-Path $FleetHome 'data\member-access.key'
      $sh = if (Test-Path $keyFile) { @('-H', ('X-Apra-Fleet-Member-Secret: ' + (Get-Content $keyFile -Raw).Trim())) } else { @() }
      Http POST /mcp ($h + $sh)
      $b = Get-Content $BODY -Raw -ErrorAction SilentlyContinue; $k = if ($b -match '"serverInfo":\{[^}]*\}') { $Matches[0] } else { Head $BODY 160 }
      Rec B09 'POST /mcp initialize (with access secret)' $CODE $k
      Http POST /mcp $h; Rec B15 'POST /mcp initialize without access secret' $CODE (Head $BODY 160)
      Http POST /mcp ($h + @('-H', 'Authorization: Bearer not-a-valid-token')); Rec B10 'POST /mcp with invalid bearer' $CODE (Head $BODY 160)
      Http POST /shutdown; Rec B11 'POST /shutdown (no bearer)' $CODE (Head $BODY 160)
      Http GET /api/fleet/members; Rec B12 'GET /api/fleet/members (no credential)' $CODE (Head $BODY 160)
      Http GET /ui; $k = if ((Get-Content $BODY -Raw -ErrorAction SilentlyContinue) -match 'id="root"') { 'id="root"' } else { Head $BODY 120 }; Rec B13 'GET /ui' $CODE $k
      if ($CODE -eq '200') { Shot 'B13-ui' "$BaseUrl/ui" }
      Run B14 status $AF @('status'); Rec B14 'apra-fleet status' $RC (Key $LOG @('State:'))
    }
    'U' {
      InstallNode U01
      Run U02 base-version $BaseExe @('--version'); Rec U02 'base --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      Run U03 base-install $BaseExe @('install'); Rec U03 'base install' $RC (Key $LOG @('installed successfully', '^Error'))
      RefreshPath
      HealthStep U04
      Seed U05
      Rec U05 'apra-fleet register-member --name fi-dummy --type local --llm none' $SeedMemberRC (Key $SeedMemberLog @('fi-dummy', '^Error'))
      Rec U06 'apra-fleet secret --set fi_dummy_secret --persist -y (value on stdin)' $SeedSecretRC (Key $SeedSecretLog @('fi_dummy_secret', 'stored|saved|Error'))
      $keyBefore = FleetKeyHash; $m = MemberHasDummy; $s = SecretHasDummy
      Rec U07 'registry.json has fi-dummy; secret --list has fi_dummy_secret' ([int](-not $m) + [int](-not $s)) "member=$(YesNo $m) secret=$(YesNo $s) fleet.key=$keyBefore"
      Run U08 cand-version $CandExe @('--version'); Rec U08 'cand --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      Run U09 upgrade $CandExe @('install', '--force'); Rec U09 'cand install --force' $RC (Key $LOG @('installed successfully', 'NOT running', '^Error'))
      HealthStep U10
      Run U11 installed-version $AF @('--version'); Rec U11 '~\.apra-fleet\bin\apra-fleet --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      $m = MemberHasDummy; Rec U12 'registry.json contains fi-dummy' ([int](-not $m)) "member fi-dummy present=$(YesNo $m)"
      $s = SecretHasDummy; Rec U13 'apra-fleet secret --list contains fi_dummy_secret' ([int](-not $s)) "secret fi_dummy_secret present=$(YesNo $s)"
      $keyAfter = FleetKeyHash; $kr = if ($keyBefore -eq $keyAfter -or $keyBefore -eq 'absent') { 0 } else { 1 }
      Rec U14 'sha256 ~\.apra-fleet\fleet.key before/after' $kr "before=$keyBefore after=$keyAfter"
      TaskStep U15 ApraFleet
      Run U16 status $AF @('status'); Rec U16 'apra-fleet status' $RC (Key $LOG @('State:'))
      Run U17 update-check $AF @('update', '--check'); Rec U17 'apra-fleet update --check' $RC (Key $LOG @('up to date', 'Update', 'Error'))
    }
    'U2' {
      Run V01 base-version $BaseExe @('--version'); Rec V01 'base --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      # Since v0.4.3 a no-Node user holds a core-only install (--workflows none).
      Run V02 base-install $BaseExe @('install', '--workflows', 'none'); Rec V02 'base install --workflows none (no node)' $RC (Key $LOG @('installed successfully', '^Error'))
      HealthStep V03
      Seed V04
      $m = MemberHasDummy; $s = SecretHasDummy
      $rc = if ((Ok $SeedMemberRC) -and (Ok $SeedSecretRC) -and $m -and $s) { 0 } else { 1 }
      Rec V04 'register-member fi-dummy + secret --set fi_dummy_secret' $rc "member=$(YesNo $m) secret=$(YesNo $s) (register rc=$SeedMemberRC, secret rc=$SeedSecretRC)"
      Run V05 update $AF @('update'); Rec V05 'apra-fleet update (baseline)' $RC (Key $LOG @('up to date', 'Updating', 'Error'))
      Start-Sleep 5
      Run V06 install-force-nonode $CandExe @('install', '--force'); Rec V06 'cand install --force (no node)' $RC (Key $LOG @('fleet-se requires', '^Error'))
      Http GET /health; Rec V07 'GET /health' $CODE (Head $BODY) (VerOf $BODY)
      $argv = UpdateArgv
      Run V08 update-argv-nonode $CandExe $argv; Rec V08 "cand $($argv -join ' ') (no node)" $RC (Key $LOG @('installed successfully', 'NOT running', '^Error')) "--workflows $($argv[-1])"
      HealthStep V09
      $m = MemberHasDummy; $s = SecretHasDummy
      Rec V10 'registry.json fi-dummy + secret --list fi_dummy_secret' ([int](-not $m) + [int](-not $s)) "member=$(YesNo $m) secret=$(YesNo $s)"
      TaskStep V11 ApraFleet
      Run V12 status $AF @('status'); Rec V12 'apra-fleet status' $RC (Key $LOG @('State:'))
    }
    default { Log "unknown pass $Pass" }
  }
} catch {
  Log "UNHANDLED: $($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)"
} finally {
  # Evidence for service failures (Last Run Time / Last Result / Logon Mode).
  try { Run 'diag' 'schtasks-verbose' 'schtasks.exe' @('/query', '/tn', 'ApraFleet', '/v', '/fo', 'list') } catch {}
  Get-ChildItem (Join-Path $FleetHome 'data') -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $Logs $_.Name) -ErrorAction SilentlyContinue }
  Log "pass $Pass done"
  [IO.File]::WriteAllText((Join-Path $Out 'done.txt'), (Get-Date -Format o), $Utf8)
}
