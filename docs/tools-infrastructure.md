# Infrastructure Tools

One-time setup and maintenance tools — provisioning authentication, migrating to SSH keys, and updating the Claude CLI.

## provision_auth

Sets the `CLAUDE_CODE_OAUTH_TOKEN` environment variable on an agent so Claude CLI can authenticate.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the target agent |
| `fleet_token` | string | yes | The OAuth token value to provision |

**What it does:**

1. Looks up the agent by ID.
2. **Writes the token to shell profiles** using OS-specific commands:
   - Linux: appends `export CLAUDE_CODE_OAUTH_TOKEN="..."` to `~/.bashrc` and `~/.profile`, plus sets it in the current shell.
   - macOS: same as Linux, plus `~/.zshrc`.
   - Windows: runs `setx CLAUDE_CODE_OAUTH_TOKEN "..."`.
3. **Verifies the token** — starts a new login shell and checks if the environment variable is visible.
4. **Runs a quick auth test** — executes `claude -p "hello"` with the token explicitly set to confirm Claude can authenticate.
5. **Stores the fleet token** in the registry (separate from per-agent data) for reference.
6. Updates the agent's `lastUsed` timestamp.

**Output:** Reports whether the token was provisioned successfully, whether it's visible in a new shell, and whether the Claude auth test passed.

**Important notes:**
- The token is written to shell profile files, so it persists across SSH sessions and reboots.
- If verification fails, the token may still work after a re-login (the profile files were written, but the current shell session doesn't reflect them yet).
- Works for both local and remote agents via the strategy pattern.

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

Updates the Claude Code CLI on one or all fleet agents.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | no | UUID of a specific agent. Omit to update ALL online agents |

**What it does:**

1. **Selects agents:**
   - If `agent_id` provided: targets that single agent.
   - If omitted: tests connectivity on all registered agents in parallel, filters to only online ones.
2. **Updates each agent in parallel** (`Promise.allSettled`):
   - Gets the current Claude version via `claude --version`.
   - Runs the update command: `claude update || npm update -g @anthropic-ai/claude-code`.
   - Gets the new version via `claude --version`.
   - Compares old vs new — marks "Already up to date" if unchanged.

**Output:** A report showing each agent with `oldVersion → newVersion` and success/failure status.

**Timeout:** The update command has a 2-minute timeout per agent (120,000ms), since package downloads can be slow.

**Note:** Offline agents are silently skipped when updating all agents — they don't appear as errors in the report, they simply aren't included.
