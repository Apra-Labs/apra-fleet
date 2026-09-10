<!-- llm-context: Step-by-step guide for enabling SSH on remote machines so they can be registered as fleet members. Covers Linux (OpenSSH), macOS, and Windows (OpenSSH Server). Consult when a user can't connect to a remote member or needs to set up SSH for the first time. -->
<!-- keywords: SSH, setup, OpenSSH, Linux, macOS, Windows, sshd, firewall, key auth, remote member, connectivity -->
<!-- see-also: ../README.md (member registration after SSH is ready), adr-oob-password.md (password handling) -->

# SSH Server Setup for Fleet Members

Enable SSH on remote machines so they can be registered with `register_member`.

---

## Windows

Windows is the most involved. Run all commands in **PowerShell as Administrator**.

### 1. Install OpenSSH Server

```powershell
# Check if already installed
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'

# Install it
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

Or: **Settings > Apps > Optional Features > Add a feature > OpenSSH Server**.

### 2. Start sshd and enable on boot

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

### 3. Firewall rule

The installer usually creates this, but verify:

```powershell
# Check
Get-NetFirewallRule -Name *ssh*

# Create if missing
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

### 4. Admin user gotcha

If your user is in the **Administrators** group, SSH ignores `~/.ssh/authorized_keys`. Keys must go in:

```
C:\ProgramData\ssh\administrators_authorized_keys
```

And the file needs restricted permissions:

```powershell
# Add your public key
Add-Content C:\ProgramData\ssh\administrators_authorized_keys "ssh-ed25519 AAAA... you@host"

# Fix permissions (must be owned by SYSTEM/Administrators only)
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)"
```

### 5. Default shell

Windows OpenSSH runs commands through whatever `HKLM:\SOFTWARE\OpenSSH`'s
`DefaultShell` value is set to (`cmd.exe` when unset). Fleet probes each
Windows member at registration and records the shell it proved
(`gitbash`, `pwsh7`, or `powershell5`) -- see
[windows-shell-selection.md](windows-shell-selection.md). If you want Fleet to
send Git-Bash-dialect commands, set the SSH `DefaultShell` to `bash.exe`, or
pass `shell` explicitly to `register_member` / `update_member`:

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Program Files\Git\bin\bash.exe" -PropertyType String -Force
```

### 6. Admin vs non-admin

Fleet operations (registration, status checks, auth provisioning,
`execute_prompt`) do **not** require admin privileges. Prefer a non-admin SSH
account: Windows OpenSSH runs with full admin privileges -- UAC bypassed
entirely -- when the SSH user is in the Administrators group, so every Fleet
command would execute elevated.

Provider CLI install and update also work without admin. The Claude CLI, for
example, installs per-user to `C:\Users\<username>\.local\bin\claude.exe`; the
installer warns that `.local\bin` is not on PATH, and the fleet server
prepends it automatically before running provider commands.

### 7. Verify

From another machine:

```bash
ssh user@windows-host "echo ok"
```

If it connects but immediately closes, the default shell is likely
misconfigured (see step 5).

---

## macOS

### 1. Enable Remote Login

**System Settings > General > Sharing > Remote Login** (toggle on).

Or via terminal:

```bash
sudo systemsetup -setremotelogin on
```

### 2. Verify

```bash
ssh user@mac-host "echo ok"
```

---

## Linux (Ubuntu/Debian)

### 1. Install and start

```bash
sudo apt install openssh-server
sudo systemctl enable --now ssh
```

### 2. Verify

```bash
ssh user@linux-host "echo ok"
```

---

## Linux (RHEL/Fedora)

```bash
sudo dnf install openssh-server
sudo systemctl enable --now sshd
sudo systemctl status sshd
```

---

## Jetson / Embedded Linux

Usually pre-installed. Just confirm it's running:

```bash
sudo systemctl status sshd
```

If not running:

```bash
sudo systemctl enable --now sshd
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Connection refused** | sshd not running | Start the service (see above) |
| **Permission denied** | Wrong password or key not deployed | Check `~/.ssh/authorized_keys` on target; on Windows admin users, check `administrators_authorized_keys` (see above) |
| **`All configured authentication methods failed`** | Wrong credentials, or password auth disabled | macOS uses the account's login password, not a separate SSH password, and its usernames are case-sensitive (confirm with `whoami` on the target). If the server is key-only, set `PasswordAuthentication yes` in `/etc/ssh/sshd_config` |
| **Connection timed out** | Firewall blocking port 22 | Add inbound rule for TCP/22: Linux `sudo ufw allow ssh` or `sudo firewall-cmd --add-service=ssh --permanent && sudo firewall-cmd --reload`; Windows, see the firewall rule above. macOS opens SSH automatically when Remote Login is enabled |
| **Windows: key auth not working for admin user** | Keys in `~/.ssh/authorized_keys` are ignored for admin accounts | Move keys to `C:\ProgramData\ssh\administrators_authorized_keys` and fix permissions |
| **Host key verification failed** | Host key changed (reinstall, new machine) | `ssh-keygen -R <host>` to clear old key |
