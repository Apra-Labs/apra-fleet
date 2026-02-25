# Lifecycle Tools

Tools that manage the fleet roster — adding, listing, updating, and removing agents.

## register_agent

Registers a new machine as a fleet agent. This is the entry point for every agent — nothing else works until an agent is registered.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `friendly_name` | string | yes | Human-readable label (e.g. "web-server") |
| `agent_type` | `"local"` \| `"remote"` | no | Default: `"remote"`. Use `"local"` for same-machine agents |
| `host` | string | remote only | IP or hostname of the remote machine |
| `port` | number | no | SSH port, default 22 |
| `username` | string | remote only | SSH username |
| `auth_type` | `"password"` \| `"key"` | remote only | Authentication method |
| `password` | string | conditional | Required when `auth_type` is `"password"` |
| `key_path` | string | conditional | Required when `auth_type` is `"key"` |
| `remote_folder` | string | yes | Working directory on the target machine |

**What it does, step by step:**

1. **Validates required fields** — remote agents must have `host`, `username`, and `auth_type`. Local agents skip all SSH fields.
2. **Duplicate folder check** — rejects if another agent already uses the same folder on the same device (same host for remote, same machine for local).
3. **Tests connectivity** — remote agents get an SSH connection test with latency measurement. Local agents always pass (they're on the same machine).
4. **Detects OS** — remote agents run `uname -s` and `cmd /c ver` to determine Linux/macOS/Windows. Local agents read `process.platform` directly.
5. **Checks Claude CLI** — runs `claude --version` to verify Claude Code is installed and capture the version.
6. **Auth test (remote only)** — runs a quick `claude -p "hello"` to verify Claude can authenticate. Skipped for local agents since they inherit the current session's auth.
7. **Checks SCP availability** — remote only, used to choose file transfer strategy.
8. **Creates working folder** — `mkdir -p` (or equivalent) on the target.
9. **Persists** — saves the agent to `~/.claude-fleet/registry.json` with a generated UUID.

**Output:** Agent ID, name, type, OS, folder, auth method, latency, and any warnings (e.g. Claude CLI not found, auth failed).

**Failure modes:**
- SSH connection fails → agent is NOT registered, error returned
- Duplicate folder → agent is NOT registered
- Claude CLI missing → agent IS registered, but with a warning

## list_agents

Lists all registered fleet agents with their details.

**Parameters:** None.

**What it does:**

Reads the registry and formats every agent into a display block showing: ID, type (local/remote), host (remote only), OS, folder, auth type (remote only), session ID, created date, and last used date.

**Output:** Formatted list with box-drawing characters. Shows "No agents registered" if the fleet is empty.

## update_agent

Modifies an existing agent's registration. All fields except `agent_id` are optional — only provided fields are changed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the agent to update |
| `friendly_name` | string | no | New display name |
| `host` | string | no | New host (remote only) |
| `port` | number | no | New SSH port (remote only) |
| `username` | string | no | New SSH username (remote only) |
| `auth_type` | `"password"` \| `"key"` | no | New auth method (remote only) |
| `password` | string | no | New password (encrypted before storage) |
| `key_path` | string | no | New private key path |
| `remote_folder` | string | no | New working directory |

**What it does:**

1. Looks up the agent by ID.
2. If `remote_folder` is changing, runs the duplicate folder check (same logic as `register_agent`) — rejects if the new folder is already in use by another agent on the same device. The check excludes the current agent's own ID so "updating to the same folder" doesn't falsely trigger.
3. Encrypts password if provided (AES-256-GCM).
4. Applies updates and persists to registry.

**Output:** Updated agent details.

**Note:** This tool does NOT re-test SSH connectivity or re-detect the OS. It's a metadata update only. If you change the host or credentials, subsequent tool calls will use the new values.

## remove_agent

Unregisters a fleet agent and cleans up its connection.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | yes | UUID of the agent to remove |

**What it does:**

1. Looks up the agent by ID.
2. **Best-effort OAuth token cleanup** — tests connectivity to the agent, and if reachable, runs OS-specific commands to remove `CLAUDE_CODE_OAUTH_TOKEN` from shell profiles (`~/.bashrc`, `~/.profile`, `~/.zshrc` on Unix; registry key on Windows). Uses `sed` to delete matching lines from profile files, then `unset` in the current shell. If the agent is offline, a warning is returned but the removal still proceeds.
3. Calls `strategy.close()` — for remote agents, this closes the pooled SSH connection. For local agents, this is a no-op.
4. Removes the agent from the registry file.

**Output:** Confirmation message with agent name and ID. Includes warnings if the token could not be cleared (e.g. agent was offline).

**Note:** This does NOT delete the working folder on the target machine, nor does it remove any deployed SSH keys from the remote's `authorized_keys` file. Those remain as-is.

## shutdown_server

Gracefully shuts down the MCP server process. Since MCP servers communicate over stdio, the server cannot self-restart — the client owns the process lifecycle.

**Parameters:** None.

**What it does:**

1. Closes all pooled SSH connections.
2. Exits the process after a short delay (allowing the response to be sent).

**Usage:** Call this tool, then run `/mcp` to start a fresh instance with the latest code. Primarily useful during development when code changes need to be picked up.
