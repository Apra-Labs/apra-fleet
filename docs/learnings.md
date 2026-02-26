# Fleet Learnings

Operational knowledge gathered from real fleet usage. Will eventually become a skill for guiding users through common scenarios.

## Agent Registration Troubleshooting

### SSH Connection Refused (ECONNREFUSED)

**Symptom:** `register_agent` fails with `connect ECONNREFUSED <host>:22 — Agent was NOT registered.`

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

### Authentication Failed (All configured authentication methods failed)

**Symptom:** `register_agent` fails with `All configured authentication methods failed — Agent was NOT registered.`

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

- **For OAuth (default):** Run `claude auth login` on your local machine first. `provision_auth` copies your credentials to the remote agent.
- **For API key:** Have your Anthropic API key ready. Pass it as the `api_key` parameter to `provision_auth`.

### Auth Check Failed Warning During Registration

If `register_agent` succeeds but shows `Claude CLI auth check failed — you may need to run provision_auth`, this is normal for new agents. Run `provision_auth` with the agent's ID to set up authentication.
