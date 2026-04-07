# Infrastructure Tools

One-time setup and maintenance tools — provisioning authentication, migrating to SSH keys, and updating the LLM CLI.

## provision_llm_auth

Authenticates a fleet member for LLM CLI usage. Two flows: copy master's OAuth credentials (Claude only) or deploy an API key (all providers).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `api_key` | string | no | API key for the member's LLM provider. If provided, deploys this key instead of copying OAuth credentials |

The correct env var name is automatically determined from the member's `llm_provider`:

| Provider | Env Var |
|----------|---------|
| Claude | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| Codex | `OPENAI_API_KEY` |
| Copilot | `COPILOT_GITHUB_TOKEN` |

### Flow A — Copy Master Credentials (Claude only, no `api_key`)

Used when the user has a Claude Max subscription. Copies `~/.claude/.credentials.json` from this machine to the remote member. **Only supported for Claude members.** For all other providers, use Flow B.

1. Looks up the member by ID, verifies it's online.
2. Checks that the member uses Claude (`provider.supportsOAuthCopy()`). Returns an error with the correct `api_key` hint for non-Claude providers.
3. Reads `~/.claude/.credentials.json` from the master machine.
4. Creates `~/.claude/` on the remote member if needed.
5. Writes the credentials file to the remote member (with `chmod 600` on Unix).
6. Verifies with `claude -p "hello" --max-turns 1` to confirm a real API call succeeds.

**Output:** Reports whether credentials were deployed and whether the auth test passed. Includes advisory notes for near-expiry or expired-refreshable tokens.

**Fails if:**
- Member is not a Claude member — returns error with correct `api_key` env var for that provider.
- No credentials file exists on the master machine — prompts the user to run `/login` or use `api_key` instead.
- Token is expired with no refresh token — blocks deployment and suggests running `/login`.

**Token validation:** Before deploying, `provision_auth` checks the OAuth token's expiry. If the token is expired but has a refresh token, deployment proceeds — the member's CLI will auto-refresh on first use. If near-expiry, a warning is appended to the output.

### Flow B — API Key (`api_key` provided, all providers)

Used for pay-per-use billing. Works with all providers.

1. Looks up the member by ID, verifies it's online.
2. Resolves the correct env var name from the member's provider (e.g. `GEMINI_API_KEY` for Gemini).
3. Deploys the env var to the remote member's shell profiles:
   - Linux: `~/.bashrc` and `~/.profile`
   - macOS: `~/.bashrc`, `~/.zshrc`, and `~/.profile`
   - Windows: User environment variable via `[Environment]::SetEnvironmentVariable`
4. Verifies the key is visible in a new shell.
5. Runs a CLI check to confirm auth works:
   - Claude: `claude -p "hello" --max-turns 1` (real API call)
   - Others: `<cli> --version` (verifies the binary is reachable with the key in env)
6. Reports success.

**Output:** Reports whether the API key was provisioned, visible in a new shell, and whether the auth check passed.

### Future: Flow C — SSH Tunnel OAuth (backlog)

For users who need per-member OAuth without sharing credentials, a future flow will use SSH port forwarding to tunnel the provider's login callback server to the user's local machine.

**Important notes:**
- Both flows verify the member is online before proceeding.
- `member_detail` detects all auth methods: credentials file (Claude OAuth) and API key env var (per-provider).
- If `execute_prompt` returns an auth error for a member, call `provision_llm_auth` for that member to restore credentials, then resume the prompt with `resume=true`.

## setup_ssh_key

Generates an RSA-4096 key pair and migrates a remote member from password-based to key-based SSH authentication.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the member to set up key auth for |

**What it does:**

1. **Rejects local members** — SSH key setup is not applicable; local members don't use SSH.
2. **Rejects members already using key auth** — no-op if already migrated.
3. **Generates an RSA-4096 key pair** using Node's `crypto.generateKeyPairSync()`.
4. **Saves keys locally:**
   - Private key: `~/.apra-fleet/data/keys/{agent-id}_rsa` (mode 0600)
   - Public key: `~/.apra-fleet/data/keys/{agent-id}_rsa.pub`
5. **Deploys the public key to the remote** — runs a series of commands via the existing password-based SSH connection:
   - `mkdir -p ~/.ssh && chmod 700 ~/.ssh`
   - `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
   - Appends the public key to `authorized_keys`
6. **Tests key-based login** — creates a temporary member config with key auth and runs `echo "key-auth-ok"` to verify.
7. **Updates the member registration** — switches `authType` to `"key"`, stores `keyPath`, and removes `encryptedPassword`.

**Output:** Paths to the generated key files and confirmation of successful key-based login.

**Key design: one key per member.** Each member gets its own key pair. This allows granular revocation — you can remove one member's key from `authorized_keys` without affecting others.

**Failure handling:** If any step fails (key deployment, test login), the member remains on password auth. The error message indicates what went wrong, and the password-based connection still works.

## update_llm_cli

Updates or installs the LLM CLI on one or all fleet members. Respects each member's `llm_provider` — uses the correct install and update commands per provider.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | no | UUID of a specific member. Omit to update ALL online members |
| `install_if_missing` | boolean | no | Default: `false`. Set to `true` to install the CLI on members that don't have it |

**What it does:**

1. **Selects members:**
   - If `member_id` provided: targets that single member.
   - If omitted: tests connectivity on all registered members in parallel, filters to only online ones.
2. **Updates or installs each member in parallel** (`Promise.allSettled`):
   - Gets the current CLI version via the provider's version command.
   - If the CLI is not found and `install_if_missing` is `true`: installs using the provider's install command for the member's OS.
   - If the CLI is found: runs the provider's update command.
   - If the CLI is not found and `install_if_missing` is `false`: reports "not found" with guidance.
   - Gets the new version after the operation to confirm.
   - Compares old vs new — marks "Already up to date" if unchanged.

**Install commands per provider and OS:**

| Provider | Linux | macOS | Windows |
|----------|-------|-------|---------|
| Claude | `curl -fsSL https://claude.ai/install.sh \| bash` | same | `irm https://claude.ai/install.ps1 \| iex` |
| Gemini | `npm i -g @google/gemini-cli` | same | same |
| Codex | `npm i -g @openai/codex` | `brew install --cask codex` | binary (experimental) |
| Copilot | `curl -fsSL https://gh.io/copilot-install \| bash` | `brew install --cask copilot` | `winget install GitHub.CopilotCLI` |

**PATH handling:** On Linux/macOS, binaries installed in `~/.local/bin` may not be in PATH for non-interactive SSH sessions. All CLI commands are prefixed with `export PATH="$HOME/.local/bin:$PATH"` to ensure the binary is found.

**Output:** A report showing each member with `oldVersion → newVersion` (or `Installed: version` for fresh installs) and success/failure status.

**Timeout:** Update has a 2-minute timeout; install has a 3-minute timeout per member.

**Note:** Offline members are silently skipped when updating all members — they don't appear as errors in the report, they simply aren't included.
