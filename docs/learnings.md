# Fleet Learnings

Operational knowledge gathered from real fleet usage. Will eventually become a skill for guiding users through common scenarios.

## Member Registration Troubleshooting

### SSH Connection Refused (ECONNREFUSED)

**Symptom:** `register_member` fails with `connect ECONNREFUSED <host>:22 — Agent was NOT registered.`

**Root cause:** SSH server is not running or not enabled on the target machine.

**Platform-specific steps:**

#### macOS

SSH (Remote Login) is disabled by default on macOS.

**Via System Settings (GUI):**

1. Open **System Settings** (or System Preferences on older macOS)
2. Go to **General → Sharing**
3. Toggle on **Remote Login**
4. Choose whether to allow access for all users or specific users

**Via Terminal:**

```bash
# Enable SSH (Remote Login)
sudo systemsetup -setremotelogin on

# Verify it's running
sudo systemsetup -getremotelogin
```

#### Linux (Ubuntu/Debian)

```bash
# Install and enable SSH server
sudo apt install openssh-server
sudo systemctl enable --now sshd

# Verify it's running
sudo systemctl status sshd
```

#### Linux (RHEL/Fedora)

```bash
# Install and enable SSH server
sudo dnf install openssh-server
sudo systemctl enable --now sshd

# Verify it's running
sudo systemctl status sshd
```

#### Windows

**Via Settings (GUI):**

1. Open **Settings > Apps > Optional Features**
2. Click **Add a feature**, search for and install **OpenSSH Server**
3. Open **Services** (services.msc), find **OpenSSH SSH Server**, set startup type to **Automatic**, and start it

**Via PowerShell (Admin):**

```powershell
# Install OpenSSH Server
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start the service
Start-Service sshd

# Auto-start on boot
Set-Service sshd -StartupType Automatic

# Verify it's running
Get-Service sshd
```

#### Windows — Additional Setup for Remote Members

After installing OpenSSH Server, Windows has some quirks that can block fleet registration:

**Default shell:** Windows OpenSSH defaults to `cmd.exe`. For best compatibility with fleet commands, switch to PowerShell:

```powershell
# Set PowerShell as the default SSH shell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

**Admin users and authorized_keys:** Windows OpenSSH has a special rule for administrator accounts — it ignores `~/.ssh/authorized_keys` and instead reads `C:\ProgramData\ssh\administrators_authorized_keys`. If key-based auth fails for an admin user:

```powershell
# Add your public key to the administrators file
Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "ssh-rsa AAAA..."

# Fix permissions (must match sshd expectations)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "SYSTEM:F" /grant "BUILTIN\Administrators:F"
```

For non-admin users, `~/.ssh/authorized_keys` works normally.

**Elevated sessions:** Windows OpenSSH runs with full admin privileges when the SSH user is in the Administrators group — UAC is bypassed entirely. This means all fleet commands will execute as admin. Be aware of the security implications, especially on production machines. To avoid this, use a non-admin user account for SSH.

**Admin vs non-admin:** Fleet operations (registration, status checks, auth provisioning, execute_prompt) do **not** require admin privileges — they work with standard user accounts. Using a non-admin user is recommended for better security.

**Claude install/update on Windows:** Both install and update work without admin. Claude installs per-user to `C:\Users\<username>\.local\bin\claude.exe` — same pattern as Linux/macOS (`~/.local/bin`). The installer warns that `.local\bin` is not in PATH; the fleet server handles this automatically by prepending the path before running claude commands.

**Verify SSH is reachable:** From another machine, test with `ssh username@windows-host`. If it connects but immediately closes, the default shell may not be set correctly (see above).

### Authentication Failed (All configured authentication methods failed)

**Symptom:** `register_member` fails with `All configured authentication methods failed — Agent was NOT registered.`

SSH is reachable but the credentials are wrong. Common causes:

- **Wrong password** — macOS uses the user's login password, not a separate SSH password
- **Password auth disabled** — some systems only allow key-based auth by default. Check `/etc/ssh/sshd_config` for `PasswordAuthentication yes`
- **Wrong username** — macOS usernames are case-sensitive and may differ from the display name (check with `whoami` on the target)

### Firewall Blocking Port 22

If SSH is enabled but connection still refused, check firewall rules:

- **Linux:** `sudo ufw allow ssh` or `sudo firewall-cmd --add-service=ssh --permanent && sudo firewall-cmd --reload`
- **macOS:** SSH through the firewall is allowed automatically when Remote Login is enabled
- **Windows:** `New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22`

## Auth Provisioning

### Prerequisites

- **For OAuth (default):** Run `/login` in your Claude Code session (or `claude auth login` from terminal) first. `provision_auth` copies your credentials to the remote member.
- **For API key:** Have your Anthropic API key ready. Pass it as the `api_key` parameter to `provision_auth`.

`provision_auth` checks token expiry before deploying. If your access token is expired but a refresh token exists, deployment proceeds — the member's CLI will auto-refresh on first use.

### Auth Check Failed Warning During Registration

If `register_member` succeeds but shows `Claude CLI auth check failed — you may need to run provision_auth`, this is normal for new members. Run `provision_auth` with the member's ID to set up authentication.

## Local Member on Windows — Pristine Shell Issues

### Problem: `claude -p` Hangs Inside a Claude Code Session

When the MCP server runs inside a Claude Code session, `LocalStrategy.execCommand()` spawns child processes that inherit the parent's environment. Two issues caused `claude -p` to hang indefinitely with zero output:

**Issue 1: `CLAUDECODE` env var leaks into child process**

Claude Code sets `CLAUDECODE=1` in its process environment. When a child `claude -p` process sees this var, it refuses to start (nested session protection). The original fix (`delete env.CLAUDECODE` from a copy of `process.env`) was fragile — it only stripped one known var and leaked the full parent environment.

**Fix:** Added `cleanExec(command)` to the `OsCommands` strategy interface. Each OS provides a pristine shell:
- **Linux/macOS:** Wraps command in `env -i bash -l -c '...'` — clears the entire env, rebuilds from login profiles.
- **Windows:** Reads Machine + User registry env vars via `[Environment]::GetEnvironmentVariables()`, adds Windows session-level vars (USERPROFILE, APPDATA, SystemRoot, etc.), caches the result. Returns this as the `env` option to `exec()`, completely replacing `process.env`.

**Issue 2: `exec()` leaves stdin open**

Node's `child_process.exec()` connects the child's stdin to the parent. `claude -p` detects it's connected to a non-TTY pipe and waits for input that never arrives — hanging indefinitely. This happened regardless of environment variables.

**Fix:** Added `child.stdin?.end()` immediately after the `exec()` call in `LocalStrategy.execCommand()`. This closes stdin so `claude` proceeds with the `-p` prompt argument instead of waiting for piped input.

**Issue 3: Windows session-level env vars missing from registry**

The initial `getCleanEnv()` implementation only added 4 session vars (USERPROFILE, HOMEDRIVE, HOMEPATH, USERNAME). Windows creates ~18 session-level vars at login that are NOT stored in the registry (SystemRoot, APPDATA, LOCALAPPDATA, ProgramFiles, etc.). Without SystemRoot, many Windows system APIs fail. Without APPDATA, applications can't find their config directories.

**Fix:** Expanded the session var list to include all well-known Windows login-time variables.

### Debugging Technique

To isolate the stdin hang, tested with `spawn()` + `child.stdin.end()` vs `exec()` (which leaves stdin open). The `spawn` variant completed in 2 seconds; `exec` hung for 60+ seconds until killed. This confirmed the root cause was stdin, not environment.

### Key Takeaway

When spawning CLI tools from Node.js that are designed for interactive use, always close stdin if you don't intend to pipe input. This applies to any tool that might check for TTY/pipe and alter its behavior accordingly.

## MCP Tool Output

MCP tool results get collapsed in Claude Code's console (shown as "+N lines", requiring Ctrl+O to expand). Returning JSON from tools works best — the agent parses the structured data and renders it in its own response, which displays fully. Avoid formatting tables or reports in tool output; let the agent handle presentation.
