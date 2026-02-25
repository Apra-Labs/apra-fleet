# Infrastructure Tools

One-time setup and maintenance tools — provisioning authentication, migrating to SSH keys, and updating the Claude CLI.

## provision_auth

Authenticates a fleet agent for Claude CLI usage. Two flows: copy master's OAuth credentials (default) or deploy an API key.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the target agent |
| `api_key` | string | no | Anthropic API key override. If provided, deploys this key instead of copying OAuth credentials |

### Flow A — Copy Master Credentials (default, no `api_key`)

Used when the user has a Max subscription. Copies `~/.claude/.credentials.json` from this machine to the remote agent.

1. Looks up the agent by ID, verifies it's online.
2. Reads `~/.claude/.credentials.json` from the master machine.
3. Creates `~/.claude/` on the remote agent if needed.
4. Writes the credentials file to the remote agent (with `chmod 600` on Unix).
5. Verifies with `claude -p "hello" --max-turns 1` to confirm a real API call succeeds.

**Output:** Reports whether credentials were deployed and whether the auth test passed.

**Fails if:** No credentials file exists on the master machine — prompts the user to run `claude auth login` locally first or use `api_key` instead.

### Flow B — API Key Override (`api_key` provided)

Used for pay-per-use billing without a Claude subscription.

1. Looks up the agent by ID, verifies it's online.
2. Deploys `ANTHROPIC_API_KEY` to the remote agent's shell profiles:
   - Linux: `~/.bashrc` and `~/.profile`
   - macOS: `~/.bashrc`, `~/.zshrc`, and `~/.profile`
   - Windows: `setx ANTHROPIC_API_KEY "..."`
3. Verifies the key is visible in a new shell.
4. Runs `claude -p "hello" --max-turns 1` with the key passed inline to confirm auth works.
5. Reports success.

**Output:** Reports whether the API key was provisioned, visible in a new shell, and whether the auth test passed.

### Future: Flow C — SSH Tunnel OAuth (backlog)

For users who need per-agent OAuth without sharing credentials, a future flow will use SSH port forwarding to tunnel the `claude auth login` callback server to the user's local machine. This requires solving the `claude auth login` interactive callback flow over SSH.

**Important notes:**
- Both flows verify the agent is online before proceeding.
- `agent_detail` detects all auth methods: credentials file, OAuth token env, and API key env.

## setup_ssh_key

Generates an RSA-4096 key pair and migrates a remote agent from password-based to key-based SSH authentication.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the agent to set up key auth for |

**What it does:**

1. **Rejects local agents** — SSH key setup is not applicable; local agents don't use SSH.
2. **Rejects agents already using key auth** — no-op if already migrated.
3. **Generates an RSA-4096 key pair** using Node's `crypto.generateKeyPairSync()`.
4. **Saves keys locally:**
   - Private key: `~/.claude-fleet/keys/{agent-id}_rsa` (mode 0600)
   - Public key: `~/.claude-fleet/keys/{agent-id}_rsa.pub`
5. **Deploys the public key to the remote** — runs a series of commands via the existing password-based SSH connection:
   - `mkdir -p ~/.ssh && chmod 700 ~/.ssh`
   - `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
   - Appends the public key to `authorized_keys`
6. **Tests key-based login** — creates a temporary agent config with key auth and runs `echo "key-auth-ok"` to verify.
7. **Updates the agent registration** — switches `authType` to `"key"`, stores `keyPath`, and removes `encryptedPassword`.

**Output:** Paths to the generated key files and confirmation of successful key-based login.

**Key design: one key per agent.** Each agent gets its own key pair. This allows granular revocation — you can remove one agent's key from `authorized_keys` without affecting others.

**Failure handling:** If any step fails (key deployment, test login), the agent remains on password auth. The error message indicates what went wrong, and the password-based connection still works.

## update_claude

Updates or installs the Claude Code CLI on one or all fleet agents. Assumes agents use the native Claude installer (not npm).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | no | UUID of a specific agent. Omit to update ALL online agents |
| `install_if_missing` | boolean | no | Default: `false`. Set to `true` to install Claude on agents that don't have it |

**What it does:**

1. **Selects agents:**
   - If `agent_id` provided: targets that single agent.
   - If omitted: tests connectivity on all registered agents in parallel, filters to only online ones.
2. **Updates or installs each agent in parallel** (`Promise.allSettled`):
   - Gets the current Claude version via `claude --version`.
   - If Claude is not found and `install_if_missing` is `true`: installs using the native installer (`curl -fsSL https://claude.ai/install.sh | bash` on Linux/macOS, `irm https://claude.ai/install.ps1 | iex` on Windows).
   - If Claude is found: runs `claude update`.
   - If Claude is not found and `install_if_missing` is `false`: reports "not found" with guidance.
   - Gets the new version via `claude --version` to confirm.
   - Compares old vs new — marks "Already up to date" if unchanged.

**PATH handling:** On Linux/macOS, the native installer places Claude in `~/.local/bin`, which may not be in PATH for non-interactive SSH sessions. All Claude commands are prefixed with `export PATH="$HOME/.local/bin:$PATH"` to ensure the binary is found.

**Output:** A report showing each agent with `oldVersion → newVersion` (or `Installed: version` for fresh installs) and success/failure status.

**Timeout:** Update has a 2-minute timeout; install has a 3-minute timeout per agent.

**Note:** Offline agents are silently skipped when updating all agents — they don't appear as errors in the report, they simply aren't included.
