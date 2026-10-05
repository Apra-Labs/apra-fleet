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
  # A failed request must not leave an earlier response looking like this one's.
  Remove-Item -LiteralPath $script:BODY -ErrorAction SilentlyContinue
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

# Summary of the ApraFleet task XML: logon=<DOMAIN\user|ANY-USER|none>
# repeat=<interval|none> policy=<...> action=<wscript-launcher|bat|other:...>.
# Sets $script:TaskMiss to what the NEW form lacks (empty = new form).
function TaskSummary($id) {
  Run $id 'task-xml' 'schtasks.exe' @('/query', '/tn', 'ApraFleet', '/xml')
  $x = Get-Content -LiteralPath $script:LOG -Raw -Encoding UTF8
  $logon = 'none'
  if ($x -match '(?s)<LogonTrigger>(.*?)</LogonTrigger>') { $lt = $Matches[1]; if ($lt -match '<UserId>([^<]+)</UserId>') { $logon = $Matches[1].Trim() } else { $logon = 'ANY-USER' } }
  $repeat = 'none'
  if ($x -match '(?s)<TimeTrigger>(.*?)</TimeTrigger>') { if ($Matches[1] -match '<Interval>([^<]+)</Interval>') { $repeat = $Matches[1].Trim() } }
  $policy = if ($x -match '<MultipleInstancesPolicy>([^<]+)<') { $Matches[1].Trim() } else { 'default' }
  $cmd = if ($x -match '<Command>([^<]+)</Command>') { $Matches[1].Trim() } else { '' }
  $targs = if ($x -match '<Arguments>([^<]+)</Arguments>') { $Matches[1].Trim() } else { '' }
  $action = "other:$cmd $targs"
  if ($cmd -match 'wscript\.exe"?$' -and $targs -match 'apra-fleet-service\.js') { $action = 'wscript-launcher' }
  if ($cmd -match 'apra-fleet-service\.bat"?$' -and -not $targs) { $action = 'bat' }
  $miss = @()
  if (-not (Ok $script:RC)) { $miss += "task query failed (exit $($script:RC))" }
  if ($logon -notmatch '\\') { $miss += 'user-scoped LogonTrigger' }
  if ($repeat -ne 'PT5M') { $miss += 'PT5M revive TimeTrigger' }
  if ($policy -ne 'IgnoreNew') { $miss += 'IgnoreNew policy' }
  if ($action -like 'other:*') { $miss += 'wscript launcher (or .bat) action' }
  $script:TaskMiss = $miss
  return "logon=$logon repeat=$repeat policy=$policy action=$action"
}
# The task is the NEW form (optionally scoped to $wantUser).
function TaskFormStep($id, $wantUser = '') {
  $k = TaskSummary $id
  $miss = @($script:TaskMiss)
  if ($wantUser -and $k -notmatch ('logon=\S*\\' + [regex]::Escape($wantUser) + ' ')) { $miss += "LogonTrigger scoped to $wantUser" }
  $obs = if ($miss.Count) { 'NOT the new task form; missing: ' + ($miss -join ', ') } else { 'new form' }
  Rec $id 'schtasks /query /tn ApraFleet /xml (new form?)' ([int]($miss.Count -gt 0)) $k $obs
}
# apra-fleet status output ($file) shows no legacy-task hint.
function NoLegacyHintStep($id, $file) {
  $hit = Get-Content -LiteralPath $file -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match 'legacy task|upgrade needed|schtasks /delete' } | Select-Object -First 1
  $svc = FirstMatch $file 'Service:'
  if ($hit) { Rec $id 'apra-fleet status: no legacy-task hint' 1 $hit.Trim() 'status still reports a legacy task' }
  elseif (-not $svc) { Rec $id 'apra-fleet status: no legacy-task hint' 1 (Head $file 160) 'status printed no Service: line (status did not run?)' }
  else { Rec $id 'apra-fleet status: no legacy-task hint' 0 $svc 'no legacy hint' }
}
# Exactly one process listens on the server port, and it is apra-fleet.
function OneServerStep($id) {
  $pids = @(Get-NetTCPConnection -LocalPort 7523 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  $names = @($pids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName })
  $all = @(Get-Process apra-fleet -ErrorAction SilentlyContinue).Count
  $ok = ($pids.Count -eq 1) -and ($names -join ',') -eq 'apra-fleet'
  Rec $id 'Get-NetTCPConnection -LocalPort 7523 -State Listen' ([int](-not $ok)) "listeners=$($pids.Count) pids=$($pids -join ',') names=$($names -join ',')" "apra-fleet processes=$all"
}

# --- pass UL: the same user, NOT elevated ------------------------------------
# A 0.4.3 user's "normal shell": the same account without its admin rights.
# The runner account never gets a UAC-filtered token: a Limited scheduled task
# ran at High integrity, and runas /trustlevel:0x20000 made Administrators
# deny-only but stayed High -- and a task registered elevated stays writable
# from High. AsLimited below builds the Medium token UAC would.
$UlDir = Join-Path $env:SystemDrive 'fi-ul'
# Absolute: Git for Windows puts a GNU whoami on PATH that rejects /groups.
$WhoAmI = Join-Path $env:SystemRoot 'System32\whoami.exe'
# Integrity level of the current context, e.g. "High Mandatory Level".
function IntegrityLevel {
  $row = (& $WhoAmI /groups /fo csv 2>$null) | ConvertFrom-Csv | Where-Object { $_.'Group Name' -like 'Mandatory Label\*' } | Select-Object -First 1
  if ($row) { return ($row.'Group Name' -replace '^Mandatory Label\\', '') } else { return 'unknown' }
}
# A normal (non-elevated) shell's token for THIS user, built the way UAC builds
# it: a LUA-restricted copy of our own token (Administrators deny-only, no
# admin privileges) lowered to Medium integrity. CreateProcessAsUser needs no
# extra privilege for a restricted copy of the caller's own token.
$FiLimitedSrc = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FiLimited {
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
    uint disableSidCount, IntPtr sidsToDisable, uint deletePrivCount, IntPtr privsToDelete, uint restrictedSidCount, IntPtr sidsToRestrict, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr tok, int cls, ref TOKEN_MANDATORY_LABEL info, int len);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr tok, string app,
    StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static Exception Fail(string what) { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), what); }
  // Exit code of cmdLine run with the restricted Medium token; -2 on timeout.
  public static int Run(string cmdLine, int timeoutMs) {
    IntPtr tok, rtok, sid;
    // ASSIGN_PRIMARY | DUPLICATE | QUERY | ADJUST_DEFAULT | ADJUST_SESSIONID
    if (!OpenProcessToken(GetCurrentProcess(), 0x1 | 0x2 | 0x8 | 0x80 | 0x100, out tok)) throw Fail("OpenProcessToken");
    // DISABLE_MAX_PRIVILEGE | LUA_TOKEN
    if (!CreateRestrictedToken(tok, 0x1 | 0x4, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out rtok)) throw Fail("CreateRestrictedToken");
    if (!ConvertStringSidToSid("S-1-16-8192", out sid)) throw Fail("ConvertStringSidToSid");
    TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
    tml.Label.Sid = sid; tml.Label.Attributes = 0x20; // SE_GROUP_INTEGRITY
    if (!SetTokenInformation(rtok, 25, ref tml, Marshal.SizeOf(tml) + GetLengthSid(sid))) throw Fail("SetTokenInformation(TokenIntegrityLevel)");
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi;
    // CREATE_NO_WINDOW
    if (!CreateProcessAsUser(rtok, null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi)) throw Fail("CreateProcessAsUser");
    try {
      if (WaitForSingleObject(pi.hProcess, (uint)timeoutMs) != 0) return -2;
      uint code; GetExitCodeProcess(pi.hProcess, out code); return (int)code;
    } finally { CloseHandle(pi.hProcess); CloseHandle(pi.hThread); CloseHandle(rtok); CloseHandle(tok); }
  }
}
'@
# Run a command as THIS user with that non-elevated token: no console, no TTY,
# so no prompt is possible. Sets $script:RC/$script:LOG/$script:LimToken.
function AsLimited($id, $name, $exe, [string[]]$argv = @(), $timeoutSec = 900) {
  if (-not ('FiLimited' -as [type])) { Add-Type -TypeDefinition $FiLimitedSrc -Language CSharp }
  $script:LOG = Join-Path $Logs "$id-$name.log"
  $out = Join-Path $UlDir "$id-$name.out"; $rcf = Join-Path $UlDir "$id-$name.rc"; $cmdf = Join-Path $UlDir "$id-$name.cmd"
  Remove-Item $out, $rcf, "$rcf.tmp" -ErrorAction SilentlyContinue
  $line = (Quote $exe) + ' ' + (($argv | ForEach-Object { Quote $_ }) -join ' ')
  # First the token this process really got (integrity level, Administrators
  # state). Redirection before echo: "echo 1> f" would make 1 a stream number.
  $ilf = "$out.il"; Remove-Item $ilf -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($cmdf, "@echo off`r`n`"$WhoAmI`" /groups /fo csv > `"$ilf`" 2>&1`r`n$line > `"$out`" 2>&1`r`n>`"$rcf.tmp`" echo %ERRORLEVEL%`r`nmove /y `"$rcf.tmp`" `"$rcf`" >nul`r`n", [Text.Encoding]::ASCII)
  $script:RC = 'ERR not run'
  try {
    $code = [FiLimited]::Run("cmd.exe /d /c `"$cmdf`"", $timeoutSec * 1000)
    if ($code -eq -2) { $script:RC = "ERR timeout after ${timeoutSec}s (restricted-token process)" }
    elseif (Test-Path $rcf) { $script:RC = ([string](Get-Content $rcf -Raw)).Trim() }
    else { $script:RC = "$code" }
  } catch { $script:RC = "ERR restricted-token launch failed: $($_.Exception.InnerException.Message)$($_.Exception.Message)" }
  $script:LimToken = 'token unknown (no whoami output)'
  try {
    $rows = Get-Content $ilf -ErrorAction Stop | ConvertFrom-Csv
    $il = ($rows | Where-Object { $_.'Group Name' -like 'Mandatory Label\*' } | Select-Object -First 1).'Group Name' -replace '^Mandatory Label\\', ''
    $adm = ($rows | Where-Object { $_.'Group Name' -eq 'BUILTIN\Administrators' } | Select-Object -First 1).Attributes
    $script:LimToken = "IL=$il; Administrators=$adm"
  } catch {}
  $text = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { '(no output file)' }
  [IO.File]::WriteAllText($script:LOG, "$text`r`n=== TOKEN: $($script:LimToken) ===`r`n=== EXIT CODE: $($script:RC) ===`r`n", $Utf8)
}
function FirstMatch($file, $pattern) {
  $m = Get-Content -LiteralPath $file -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if ($m) { return $m.Trim() } else { return '' }
}

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
      Http POST /mcp $h
      $b = Get-Content $BODY -Raw -ErrorAction SilentlyContinue; $k = if ($b -match '"serverInfo":\{[^}]*\}') { $Matches[0] } else { Head $BODY 160 }
      Rec B09 'POST /mcp initialize' $CODE $k
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
      Run U16 status $AF @('status'); Rec U16 'apra-fleet status' $RC (Key $LOG @('State:')); $StatusLog = $LOG
      Run U17 update-check $AF @('update', '--check'); Rec U17 'apra-fleet update --check' $RC (Key $LOG @('up to date', 'Update', 'Error'))
      # The baseline's onlogon task was replaced by the new form (elevated runner: /create /xml /f allowed).
      TaskFormStep U18
      NoLegacyHintStep U19 $StatusLog
      OneServerStep U20
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
      Run V12 status $AF @('status'); Rec V12 'apra-fleet status' $RC (Key $LOG @('State:')); $StatusLog = $LOG
      TaskFormStep V13
      NoLegacyHintStep V14 $StatusLog
      OneServerStep V15
    }
    'UL' {
      # Probe (advisory): UAC policy and this context's integrity level -- would a
      # RunAs elevation be auto-approved here, and is the runner elevated.
      $pol = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue
      Rec L00 'UAC policy + integrity level' 0 "EnableLUA=$($pol.EnableLUA) ConsentPromptBehaviorAdmin=$($pol.ConsentPromptBehaviorAdmin) PromptOnSecureDesktop=$($pol.PromptOnSecureDesktop) IL=$(IntegrityLevel) SESSIONNAME=$env:SESSIONNAME user=$(whoami)"
      New-Item -ItemType Directory -Force $UlDir | Out-Null
      # Created elevated (owner Administrators): let the filtered token write its results.
      & icacls.exe $UlDir /grant '*S-1-5-11:(OI)(CI)M' | Out-Null
      # The same user's filtered token must be MEDIUM integrity (not elevated).
      AsLimited L01 whoami $WhoAmI @('/groups', '/fo', 'csv') 120
      $medium = $script:LimToken -match 'IL=Medium Mandatory Level' -and $script:LimToken -match 'Administrators=Group used for deny only'
      Rec L01 'limited-token context of the same user is not elevated' ([int](-not ($medium -and (Ok $RC)))) "rc=$RC $($script:LimToken)" $(if ($medium) { 'medium integrity' } else { 'the restricted-token process did not run at Medium integrity with Administrators deny-only, so it cannot stand in for a normal shell' })

      Run L02 base-version $BaseExe @('--version'); Rec L02 'base --version' $RC (Key $LOG @('apra-fleet v')) (VerOf $LOG)
      # The baseline install from the ELEVATED runner context, as 0.4.3 users had to:
      # its schtasks /sc onlogon registers the legacy task.
      Run L03 base-install $BaseExe @('install', '--workflows', 'none'); Rec L03 'base install --workflows none (elevated)' $RC (Key $LOG @('installed successfully', '^Error'))
      $k = TaskSummary L04
      Rec L04 'legacy task registered by the baseline' $RC $k
      HealthStep L05 120

      # Upgrade from the non-elevated token: /create /xml /f must be denied -> legacy task reused.
      AsLimited L06 upgrade $CandExe @('install', '--force', '--workflows', 'none')
      $UpLog = $LOG
      Rec L06 'cand install --force --workflows none (not elevated)' $RC (Key $LOG @('installed successfully', 'NOT running', '^Error')) $script:LimToken
      $reused = FirstMatch $UpLog 'existing task reused'
      $guid = FirstMatch $UpLog 'registered by an older apra-fleet from an elevated prompt'
      $why = if (-not $reused) { "no 'existing task reused': the non-elevated /create was NOT denied, so the legacy precondition did not hold" } elseif (-not $guid) { 'reused, but no legacy-task guidance printed' } else { 'reused with guidance' }
      Rec L07 'install output: legacy task reused + guidance' ([int](-not ($reused -and $guid))) "$reused | $guid" $why
      $elev = FirstMatch $UpLog 'Requesting a one-time Windows elevation|Elevation declined|elevated step could not be started|elevated delete'
      Rec L08 'no elevation attempted (non-interactive)' ([int][bool]$elev) $(if ($elev) { $elev } else { 'no elevation attempted' })
      $k = TaskSummary L09
      $kept = $k -match 'logon=ANY-USER repeat=none' -and $k -match 'action=bat'
      Rec L09 'legacy task still in place (not replaced)' ([int](-not $kept)) $k $(if ($kept) { 'legacy task kept' } else { 'the legacy task changed although a non-elevated install cannot change it' })
      $nf = Join-Path $FleetHome 'data\service-notice.json'
      $nt = Get-Content $nf -Raw -ErrorAction SilentlyContinue
      $nok = $nt -and $nt -match 'schtasks /delete /tn ApraFleet /f' -and $nt -match 'no automatic revive'
      Rec L10 "notice file $nf" ([int](-not $nok)) $(if ($nt) { Head $nf 160 } else { 'service-notice.json missing' })
      $fl = Join-Path $FleetHome 'data\fleet.log'
      $ll = FirstMatch $fl 'apra-fleet install: The ApraFleet scheduled task was registered by an older apra-fleet'
      Rec L11 'fleet.log has the legacy-task guidance' ([int](-not $ll)) $(if ($ll) { $ll } else { "no 'apra-fleet install: The ApraFleet scheduled task ...' line in $fl" })
      # The server came back through the OLD task (started by the non-elevated install).
      HealthStep L12 120
      AsLimited L13 status $AF @('status')
      $hint = FirstMatch $LOG 'legacy task \(upgrade needed:'; $fix = FirstMatch $LOG 'schtasks /delete /tn ApraFleet /f'
      Rec L13 'apra-fleet status (not elevated) shows the legacy hint + fix' ([int](-not ($hint -and $fix))) "$hint | $fix" $(if (-not $hint) { 'no legacy task (upgrade needed: ...) hint' } elseif (-not $fix) { 'hint without the schtasks /delete fix' } else { 'hint + fix' })

      # The documented fix: elevated delete, then a non-elevated install --force.
      Run L14 fix-delete 'schtasks.exe' @('/delete', '/tn', 'ApraFleet', '/f'); Rec L14 'elevated: schtasks /delete /tn ApraFleet /f' $RC (Key $LOG @('SUCCESS', 'ERROR'))
      # Runner artifact, NOT part of the documented fix: this account has no
      # filtered token, so the legacy task ran the server at High integrity,
      # which no Medium process may stop. On a real UAC machine the task
      # (/rl limited, the user's interactive token) runs it at Medium and the
      # install --force below stops it itself. Stop it elevated here instead.
      $hp = @(Get-Process apra-fleet -ErrorAction SilentlyContinue | ForEach-Object Id)
      Run L14b stop-high-server 'taskkill.exe' (@('/F') + ($hp | ForEach-Object { @('/PID', "$_") }))
      Rec L14b 'runner artifact: stop the High-integrity legacy server (elevated)' $(if ($hp.Count) { $RC } else { 0 }) $(if ($hp.Count) { Key $LOG @('SUCCESS', 'ERROR') } else { 'no apra-fleet process running' }) "pids: $($hp -join ',')"
      AsLimited L15 fix-install $AF @('install', '--force', '--workflows', 'none')
      Rec L15 'apra-fleet install --force --workflows none (not elevated)' $RC (Key $LOG @('installed successfully', '^Error')) "$($script:LimToken); exe present=$(YesNo (Test-Path $AF))"
      TaskFormStep L16 $env:USERNAME
      $gone = -not (Test-Path $nf)
      Rec L17 'service-notice.json removed by the new task' ([int](-not $gone)) $(if ($gone) { 'notice cleared' } else { 'service-notice.json still present after the new task was installed' })
      AsLimited L18 status-after $AF @('status')
      NoLegacyHintStep L18 $LOG
      # The new task (created without elevation) runs the candidate.
      HealthStep L19 120
      OneServerStep L20
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
