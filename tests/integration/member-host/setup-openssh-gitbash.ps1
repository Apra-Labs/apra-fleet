# Disposable-VM setup for the member-host harness: installs and starts the
# Windows OpenSSH server with Git Bash (bash.exe) as its DefaultShell, creates a
# throwaway local user to act as the member, generates a THROWAWAY key pair in
# the runner temp dir and authorizes it for localhost only.
#
# REFUSES (exit 2) unless BOTH env CI=true and -IAmDisposable are given: it
# changes system state (a Windows capability, a service, a local user, the sshd
# config) and never cleans up. Mirrors lib/opt-in.mjs disposableRefusal().
# Never reads or writes real credentials: the key and the user's password are
# generated here, per run; the password is never printed.
#
#   pwsh -File setup-openssh-gitbash.ps1 -IAmDisposable [-KeyDir <dir>] [-InfoFile <path>]
#
# Writes <InfoFile> (JSON: user, keyPath, port, home, bash) for run.mjs.
param(
  [switch]$IAmDisposable,
  [string]$KeyDir = (Join-Path ($(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP })) 'member-host-ssh'),
  [string]$InfoFile = (Join-Path ($(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP })) 'member-host-info.json'),
  [string]$MemberUser = 'fleetmember'
)
$ErrorActionPreference = 'Stop'

if (-not $IAmDisposable -or $env:CI -ne 'true') {
  [Console]::Error.WriteLine('REFUSED: this script installs an SSH server, creates a user and changes sshd config on THIS machine and never cleans up; it only runs on a disposable CI VM. Set CI=true and pass -IAmDisposable only on a throwaway machine.')
  exit 2
}
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') {
  [Console]::Error.WriteLine('REFUSED: the OpenSSH + Git Bash member host is a Windows setup.')
  exit 2
}

$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash" }

# 1. OpenSSH server
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }

# 2. DefaultShell = Git Bash (the shape that lost argv for quote-led commands)
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $bash -PropertyType String -Force | Out-Null

# 3. Throwaway member user (random password, never printed)
Add-Type -AssemblyName System.Web
$pw = [System.Web.Security.Membership]::GeneratePassword(24, 4)
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
if (-not (Get-LocalUser -Name $MemberUser -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $MemberUser -Password $sec -PasswordNeverExpires -AccountNeverExpires | Out-Null
}
$home = Join-Path 'C:\Users' $MemberUser
New-Item -ItemType Directory -Force -Path (Join-Path $home '.ssh') | Out-Null

# 4. Throwaway key pair in the temp dir, authorized for localhost only
New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
$key = Join-Path $KeyDir 'member_key'
if (Test-Path $key) { Remove-Item -Force $key, "$key.pub" }
ssh-keygen -q -t ed25519 -N '""' -f $key | Out-Null
$pub = (Get-Content "$key.pub" -Raw).Trim()
$authLine = "from=`"127.0.0.1,::1`" $pub"
$authFile = Join-Path $home '.ssh\authorized_keys'
Set-Content -Path $authFile -Value $authLine -Encoding ascii
icacls $authFile /inheritance:r /grant "${MemberUser}:F" /grant 'SYSTEM:F' /grant 'Administrators:F' | Out-Null

# 5. Start sshd and wait for it to answer on localhost
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 22 -WarningAction SilentlyContinue).TcpTestSucceeded) { break }
  Start-Sleep -Seconds 2
}
if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 22 -WarningAction SilentlyContinue).TcpTestSucceeded) { throw 'sshd did not start answering on 127.0.0.1:22' }

@{ user = $MemberUser; keyPath = $key; port = 22; home = $home; bash = $bash } | ConvertTo-Json | Set-Content -Path $InfoFile -Encoding ascii
Write-Host "member host ready: $MemberUser@127.0.0.1:22 (info: $InfoFile)"
