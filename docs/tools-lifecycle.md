# Lifecycle Tools

Tools that manage the fleet roster — adding, listing, updating, and removing members.

## register_member

Registers a new machine as a fleet member. This is the entry point for every member — nothing else works until a member is registered.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `friendly_name` | string | yes | Human-readable label (e.g. "web-server") |
| `agent_type` | `"local"` \| `"remote"` | no | Default: `"remote"`. Use `"local"` for same-machine members |
| `host` | string | remote only | IP or hostname of the remote machine |
| `port` | number | no | SSH port, default 22 |
| `username` | string | remote only | SSH username |
| `auth_type` | `"password"` \| `"key"` | remote only | Authentication method |
| `password` | string | conditional | Required when `auth_type` is `"password"` |
| `key_path` | string | conditional | Required when `auth_type` is `"key"` |
| `work_folder` | string | yes | Working directory on the target machine |

**What it does, step by step:**

1. **Validates required fields** — remote members must have `host`, `username`, and `auth_type`. Local members skip all SSH fields.
2. **Duplicate folder check** — rejects if another member already uses the same folder on the same device (same host for remote, same machine for local).
3. **Tests connectivity** — remote members get an SSH connection test with latency measurement. Local members always pass (they're on the same machine).
4. **Detects OS** — remote members run `uname -s` and `cmd /c ver` to determine Linux/macOS/Windows. Local members read `process.platform` directly.
5. **Checks Claude CLI** — runs `claude --version` to verify Claude Code is installed and capture the version.
6. **Auth test (remote only)** — runs a quick `claude -p "hello"` to verify Claude can authenticate. Skipped for local members since they inherit the current session's auth.
7. **Creates working folder** — `mkdir -p` (or equivalent) on the target.
8. **Persists** — saves the member to `~/.apra-fleet/data/registry.json` with a generated UUID.

**Output:** Member ID, name, type, OS, folder, auth method, latency, and any warnings (e.g. Claude CLI not found, auth failed).

**Failure modes:**
- SSH connection fails → member is NOT registered, error returned
- Duplicate folder → member is NOT registered
- Claude CLI missing → member IS registered, but with a warning

## list_members

Lists all registered fleet members with their details.

**Parameters:** None.

**What it does:**

Reads the registry and formats every member into a display block showing: ID, type (local/remote), host (remote only), OS, folder, auth type (remote only), session ID, created date, and last used date.

**Output:** Formatted list with box-drawing characters. Shows "No members registered" if the fleet is empty.

## update_member

Modifies an existing member's registration. All fields except `member_id` are optional — only provided fields are changed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the member to update |
| `friendly_name` | string | no | New display name |
| `host` | string | no | New host (remote only) |
| `port` | number | no | New SSH port (remote only) |
| `username` | string | no | New SSH username (remote only) |
| `auth_type` | `"password"` \| `"key"` | no | New auth method (remote only) |
| `password` | string | no | New password (encrypted before storage) |
| `key_path` | string | no | New private key path |
| `work_folder` | string | no | New working directory |

**What it does:**

1. Looks up the member by ID.
2. If `work_folder` is changing, runs the duplicate folder check (same logic as `register_member`) — rejects if the new folder is already in use by another member on the same device. The check excludes the current member's own ID so "updating to the same folder" doesn't falsely trigger.
3. Encrypts password if provided (AES-256-GCM).
4. Applies updates and persists to registry.

**Output:** Updated member details.

**Note:** This tool does NOT re-test SSH connectivity or re-detect the OS. It's a metadata update only. If you change the host or credentials, subsequent tool calls will use the new values.

## remove_member

Unregisters a fleet member and cleans up its connection.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the member to remove |

**What it does:**

1. Looks up the member by ID.
2. **Best-effort auth cleanup** — tests connectivity to the member, and if reachable: removes `~/.claude/.credentials.json` (OAuth credentials file) and removes `ANTHROPIC_API_KEY` from shell profiles (`~/.bashrc`, `~/.profile`, `~/.zshrc` on Unix; registry key on Windows). If the member is offline, a warning is returned but the removal still proceeds.
3. Calls `strategy.close()` — for remote members, this closes the pooled SSH connection. For local members, this is a no-op.
4. Removes the member from the registry file.

**Output:** Confirmation message with member name and ID. Includes warnings if the token could not be cleared (e.g. member was offline).

**Note:** This does NOT delete the working folder on the target machine, nor does it remove any deployed SSH keys from the remote member's `authorized_keys` file. Those remain as-is.

## shutdown_server

Gracefully shuts down the MCP server process. Since MCP servers communicate over stdio, the server cannot self-restart — the client owns the process lifecycle.

**Parameters:** None.

**What it does:**

1. Closes all pooled SSH connections.
2. Exits the process after a short delay (allowing the response to be sent).

**Usage:** Call this tool, then run `/mcp` to start a fresh instance with the latest code. Primarily useful during development when code changes need to be picked up.
