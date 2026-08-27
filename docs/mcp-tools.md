# Apra Fleet MCP Tools Reference

Complete reference for all Model Context Protocol (MCP) tools provided by the `apra-fleet` server.

The tools are organized into four functional categories:

1. [Lifecycle Tools](#1-lifecycle-tools) - Member registration, roster management, updates, removal, and server shutdown.
2. [Work Tools](#2-work-tools) - Sending files, executing LLM prompts, running shell commands, and stopping prompts.
3. [Infrastructure Tools](#3-infrastructure-tools) - LLM auth provisioning, SSH key configuration, and CLI updates.
4. [Observability Tools](#4-observability-tools) - Fleet-wide status monitoring and per-member detail inspection.

---

## 1. Lifecycle Tools

Tools that manage the fleet roster -- adding, listing, updating, and removing members.

### `register_member`

Registers a new machine as a fleet member. This is the entry point for every member -- nothing else works until a member is registered.

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
| `work_folder` | string | yes | Working directory on the target machine. For remote members, must be a fully-qualified/absolute path (e.g. `/home/bella/repo` or `C:\Users\bella\repo`) -- `~` and relative paths are rejected |
| `llm_provider` | `"claude"` \| `"codex"` \| `"copilot"` | no | Default: `"claude"`. LLM backend for this member |

**What it does, step by step:**

1. **Validates required fields** -- remote members must have `host`, `username`, and `auth_type`. Local members skip all SSH fields.
2. **Duplicate folder check** -- rejects if another member already uses the same folder on the same device (same host for remote, same machine for local).
3. **Tests connectivity** -- remote members get an SSH connection test with latency measurement. Local members always pass (they're on the same machine).
4. **Detects OS** -- remote members run `uname -s` and `cmd /c ver` to determine Linux/macOS/Windows. Local members read `process.platform` directly.
5. **Checks provider CLI** -- runs `<provider> --version` (e.g. `claude --version`, `codex --version`) to verify the LLM CLI is installed and capture the version.
6. **Auth test (remote only)** -- for Claude members, runs a quick `claude -p "hello"` to verify authentication. For non-Claude providers, the version check from step 5 serves as the CLI availability check; auth is verified separately via `provision_llm_auth`. Skipped for local members since they inherit the current session's auth.
7. **Creates working folder** -- `mkdir -p` (or equivalent) on the target.
8. **Provisions role-agent files (remote only)** -- hashes the canonical set of PM role-agent files (planner, doer, reviewer, etc., plus `_shared/` and `schemas/`) against what is already on the remote box and uploads anything missing or stale. Skipped for local members (they share the operator's home directory) and for providers with no agents directory (codex, copilot). A provisioning failure is reported as a warning but never blocks registration.
9. **Persists** -- saves the member to `~/.apra-fleet/data/registry.json` with a generated UUID, including the `llmProvider` field.

**Output:** Member ID, name, type, OS, folder, auth method, provider, latency, agent-file provisioning result, and any warnings (e.g. CLI not found, auth failed).

**Failure modes:**
- SSH connection fails: member is NOT registered, error returned
- Duplicate folder: member is NOT registered
- Claude CLI missing: member IS registered, but with a warning

### `list_members`

Lists all registered fleet members with their details.

**Parameters:** None.

**What it does:**

Reads the registry and formats every member into a display block showing: ID, type (local/remote), host (remote only), OS, LLM provider, folder, auth type (remote only), session ID, created date, and last used date.

**Output:** Formatted list with box-drawing characters. Shows "No members registered" if the fleet is empty.

### `update_member`

Modifies an existing member's registration. All fields except `member_id` are optional -- only provided fields are changed.

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
| `work_folder` | string | no | New working directory. For non-local (remote/relay) members, must be a fully-qualified/absolute path -- `~` and relative paths are rejected |
| `llm_provider` | `"claude"` \| `"codex"` \| `"copilot"` | no | Switch LLM backend |

**What it does:**

1. Looks up the member by ID.
2. If the member is not local and `work_folder` is provided, rejects it up front unless it is a fully-qualified/absolute path.
3. If `work_folder` is changing, runs the duplicate folder check (same logic as `register_member`) -- rejects if the new folder is already in use by another member on the same device. The check excludes the current member's own ID so "updating to the same folder" doesn't falsely trigger.
4. Encrypts password if provided (AES-256-GCM).
5. Applies updates and persists to registry.
6. **Re-provisions role-agent files (remote only)** -- same hash-diff-and-upload check as `register_member`, so a member that was registered before an agent file was added or changed picks it up. Skipped for local members and providers with no agents directory (codex, copilot); a provisioning failure is returned as a warning and does not fail the update.

**Output:** Updated member details.

**Note:** This tool does NOT re-test SSH connectivity or re-detect the OS. It's a metadata update only. If you change the host or credentials, subsequent tool calls will use the new values.

### `remove_member`

Unregisters a fleet member and cleans up its connection.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the member to remove |

**What it does:**

1. Looks up the member by ID.
2. **Best-effort auth cleanup** -- tests connectivity to the member, and if reachable: removes the provider's credential file (e.g. `~/.claude/.credentials.json` for Claude) if the provider supports OAuth copy, and removes the provider's auth env var (e.g. `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex) from shell profiles (`~/.bashrc`, `~/.profile`, `~/.zshrc` on Unix; registry key on Windows). If the member is offline, a warning is returned but the removal still proceeds.
3. Calls `strategy.close()` -- for remote members, this closes the pooled SSH connection. For local members, this is a no-op.
4. Removes the member from the registry file.

**Output:** Confirmation message with member name and ID. Includes warnings if the token could not be cleared (e.g. member was offline).

**Note:** This does NOT delete the working folder on the target machine, nor does it remove any deployed SSH keys from the remote member's `authorized_keys` file. Those remain as-is.

### `shutdown_server`

Gracefully shuts down the MCP server process. Since MCP servers communicate over stdio, the server cannot self-restart -- the client owns the process lifecycle.

**Parameters:** None.

**What it does:**

1. Closes all pooled SSH connections.
2. Exits the process after a short delay (allowing the response to be sent).

**Usage:** Call this tool, then run `/mcp` to start a fresh instance with the latest code. Primarily useful during development when code changes need to be picked up.

---

## 2. Work Tools

The core workflow tools -- pushing files to members, running Claude prompts, and managing conversation sessions.

### `send_files`

Uploads local files to a member's working directory.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `local_paths` | string[] | yes | Array of absolute local file paths to upload |
| `destination_path` | string | no | Optional subfolder within the member's working directory |

**What it does:**

1. Looks up the member by ID.
2. Calls `strategy.transferFiles()`:
   - **Remote members:** uploads via SFTP (creates remote directories recursively, then uses `sftp.fastPut()` for each file).
   - **Local members:** uses `fs.copyFileSync()` to copy files to the target folder. Creates the destination directory with `fs.mkdirSync({ recursive: true })` if needed.
3. Updates the member's `lastUsed` timestamp.

**Output:** Lists successfully uploaded files and any failures with error messages. Shows the remote destination path.

**Behavior details:**
- Files are placed flat in the destination -- only the basename is used, not the full source path structure.
- If `destination_path` is provided, files go to `{workFolder}/{destination_path}/`.
- Each file is transferred independently -- one failure doesn't stop the others.

### `execute_prompt`

Runs an LLM prompt on a member. This is the primary tool for doing actual work across the fleet. The tool respects each member's `llm_provider` setting -- the correct CLI is invoked automatically.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `prompt` | string | yes | The prompt text to send to the LLM agent |
| `resume` | boolean \| string | no | Default: `true`. `true` continues the member's most recently stored session if one exists. A string value is an explicit session id to resume instead -- used when a caller must target one specific prior session rather than "whatever the member last used" (e.g. a retry that must reattach to the exact session that produced a prior failed attempt). An explicit-id resume that the provider reports as not found is terminal for that dispatch, not silently retried as a fresh session -- callers needing a fallback must re-dispatch with `resume: false` themselves. |
| `fork` | boolean \| string | no | Default: unset. Branches a NEW session from an existing one instead of continuing it in place -- mirrors `resume`'s shape, but the source session is left untouched and the dispatch gets a distinct new session id seeded from the source's context. `true` forks the member's stored last session (best-effort: a stale/unknown stored session logs a warning and falls back to a plain fresh session, never a hard error). A string value forks exactly that source session id (explicit: an unknown/expired source is a TERMINAL `session_not_found`, no LLM call, no fresh-session fallback). Mutually exclusive with `resume` (any non-default value) and with `session_id` -- specifying `fork` together with either is rejected as a validation error before member resolution or any LLM call. Requires a fork-capable provider; a `fork` request against a provider that does not support fork-mode dispatch is rejected with `reason: "fork_unsupported"` and no LLM call, never silently downgraded to a plain resume/fresh dispatch. |
| `timeout_s` | number | no | Default: 300 (5 min). **Inactivity timeout** -- resets on every output chunk; kills the session only when silent for this many seconds |
| `max_total_s` | number | no | Default: none. **Hard ceiling** -- kills the session after this total elapsed time in seconds regardless of activity |
| `model` | string | no | Model to use. Pass a tier name (`premium`, `standard`, `cheap`) or a provider-specific model ID. Defaults to `standard` tier when omitted. |
| `substitutions` | object | no | Map of token name to replacement value. Replaces `{{name}}` patterns in the prompt before staging on the member. Keys must match `[A-Za-z_][A-Za-z0-9_]*`. See fleet SKILL.md Substitutions section. |

**Provider-specific behavior:**

| Aspect | Claude | Codex | Copilot |
|--------|--------|-------|---------|
| CLI invocation | `claude -p "..."` | `codex exec "..."` | `copilot -p "..."` |
| JSON output | Single JSON object | NDJSON (parsed automatically) | Single JSON object |
| `max_turns` | `--max-turns N` (default 50) | Not available (ignored) | Not available (ignored) |
| Skip permissions | `--dangerously-skip-permissions` | `--sandbox danger-full-access --ask-for-approval never` | `--allow-all-tools` |
| Session resume | `--resume <session_id>` | positional `resume` | `--continue` |

**Unattended execution:** Use `update_member(unattended='auto')` or `update_member(unattended='dangerous')` to control permission bypass. The schema is strict -- passing unknown fields returns a validation error.

**What it does:**

1. Looks up the member by ID and resolves its LLM provider (`getProvider(agent.llmProvider)`). On the first dispatch to a remote member since the server started, it also checks that member's role-agent files (planner, doer, reviewer, etc.) are current and re-provisions any missing or stale ones before proceeding -- this is what carries an already-registered member's agent files forward after an orchestrator upgrade, without requiring a `register_member`/`update_member` call first. A provisioning failure never blocks the prompt dispatch; it is retried on the next `execute_prompt` call to that member. Skipped for local members and for providers with no agents directory (codex, copilot).
2. **Base64-encodes the prompt** -- this avoids shell escaping issues when the prompt contains quotes, newlines, or special characters. The encoding is decoded on the target side before being passed to the CLI.
3. **Builds the provider command** -- via `provider.buildPromptCommand()`, which produces the correct CLI call for the member's provider and OS. Max-turns flag is only appended for Claude (the only provider that supports it).
4. **Appends the resume flag** if `resume` is truthy (`true`, or an explicit session-id string) and the member has a matching stored session. Each provider uses its own resume flag. When `fork` is active instead, this step appends the provider's fork flag in place of the resume/session-id flags -- the two are mutually exclusive by construction (see "Session forking" below), so a dispatch never carries both.
5. **Executes via strategy** -- `strategy.execCommand(cmd, timeout_s * 1000)`.
6. **Parses the response** -- via `provider.parseResponse()`. Handles Codex NDJSON transparently; extracts text and session info from all providers.
7. **Handles stale sessions** -- when resuming via `resume=true` (the member's own stored session), a command failure after a resume attempt is retried transparently with a fresh minted session ID. This transparent fallback does **not** apply when `resume` was an explicit session-id string: an unresolvable explicit id is rejected outright as `session_not_found` with no LLM call made, since silently switching to a different session would defeat the caller's reason for naming one. The caller must explicitly re-dispatch (typically with `resume=false`) to recover.
8. **Updates registry** -- stores the new `sessionId` (Claude) and `lastUsed` timestamp.

**Output:** `structuredContent.response` carries the agent's reply text; `structuredContent.usage` carries token counts when available; `structuredContent.sessionId` carries the session ID if one was returned.

**Error handling:**
- If the prompt fails due to an authentication issue, returns actionable guidance (`provision_llm_auth`) instead of raw error output.
- Automatically retries once with a 5-second backoff on transient server errors.
- A `busy` rejection is not taken at face value: before rejecting, the tool verifies the locked session's backing process is actually still alive. If confirmed dead, the stale lock self-heals -- released with a warning -- and the dispatch proceeds instead of being rejected.
- A Claude session that terminates because it hit the turn limit always classifies as `max_turns_exhausted`.

**Token accumulation:**
After each successful prompt response, the server automatically accumulates `input_tokens` and `output_tokens` from the provider's usage metadata onto the member record. Running totals are accessible via `member_detail` and `fleet_status`.

**Session behavior:**
- First prompt on a member: no session exists, agent starts fresh.
- Subsequent prompts with `resume=true`: agent continues the conversation with full context of prior exchanges.
- Fleet mints and stores the session ID for Claude, which passes it via `--session-id` on the first run and `--resume <id>` on later runs. Codex and Copilot resume the most recent local session via a generic flag.
- If the member's own stored session (`resume=true`) becomes stale, the tool automatically retries without resume. An explicit session-id resume that turns out to be stale/unknown is terminal instead (`session_not_found`, no automatic retry) -- see "Handles stale sessions" above.

**Session forking:**

`fork` addresses a different need than `resume`: instead of continuing to write into the same session, it branches a new session that starts from an existing session's transcript/context, so the original session remains unaffected by anything that happens on the fork. The motivating use case is token savings in workflows with reusable priming -- build expensive shared context (e.g. codebase orientation, architecture-review setup) once in a source session, then fork it per task so each task starts already primed without re-spending tokens to rebuild that context every time, while unrelated dispatches keep starting clean.

- `resume` and `fork` express contradictory intents (continue in place vs. branch away) and are rejected together as a validation error, checked before any member resolution or LLM call -- there is no precedence rule to fall back on because the combination is never allowed through.
- Fork support is a provider capability, not a universal guarantee: a provider adapter opts in by implementing both a support check and a fork-flag builder. A provider that has not implemented these is fork-incapable by default (there is no fallback that fakes forking by other means), and a `fork` request against it is a terminal, no-LLM-call rejection rather than a silent downgrade to resume or a fresh session.
- For a fork-capable provider, the underlying CLI mints its own new output session id from the fork invocation -- the caller does not (and cannot) supply that id up front the way it can for a caller-minted fresh session. The tool tracks whatever id comes back and records it as the forked session's identity going forward; the source session's own stored id is never overwritten by a fork.
- Explicit-id fork (`fork: "<session-id>"`) has the same terminal, no-fallback contract as explicit-id resume: an unknown or expired source id fails the dispatch outright (`session_not_found`) rather than silently forking from nothing or falling back to a fresh session. Only `fork: true` (best-effort, targeting the member's own stored session) is allowed to degrade transparently to a fresh session when the stored session turns out to be stale or absent.
- Internal retry/self-heal paths (transient dispatch failure, stale-session retry, server-overload retry, self-heal after empty response) never re-fork on retry -- a retry after a fork attempt proceeds as an ordinary fresh dispatch, since re-forking from the same source on every retry would multiply, not save, token spend.

### `execute_command`

Runs a shell command directly on a member without spinning up Claude. Use for quick tasks like installing packages, checking versions, or running scripts.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |
| `command` | string | yes | The shell command to execute |
| `timeout_s` | number | no | Default: 120 (2 minutes). Max time to wait for the command to finish |
| `run_from` | string | no | Override directory to run from. Defaults to member's registered work folder. |

**What it does:**

1. Looks up the member by ID.
2. Resolves the working directory -- uses `run_from` if provided, otherwise the member's registered `workFolder`.
3. Wraps the command with a `cd` (Unix) or `Set-Location` (Windows) into the resolved folder.
4. Executes via `strategy.execCommand()` with the specified timeout.
5. Returns stdout, stderr, and exit code.

**Output:** Exit code followed by stdout (and stderr prefixed with `[stderr]` if present).

**Security warning:** This tool executes **raw shell commands** on the target machine with full privileges of the user.

**When to use `execute_command` vs `execute_prompt`:**

| Scenario | Tool |
|----------|------|
| Install a package (`npm install`, `apt-get install`) | `execute_command` |
| Check a version (`node --version`, `git --version`) | `execute_command` |
| Run a build or test script | `execute_command` |
| Ask Claude to analyze code, write code, or reason about a task | `execute_prompt` |
| Tasks requiring multi-step reasoning or tool use | `execute_prompt` |

### `stop_prompt`

Terminates the active LLM session on a member and prevents further `execute_prompt` dispatches until the next explicit call.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | one of | UUID of the target member |
| `member_name` | string | one of | Friendly name of the target member |

**What it does:**

1. Kills the LLM process PID stored for the member using a platform-appropriate kill command (`kill -9` on Unix, `taskkill /F /T /PID` on Windows).
2. Sets a stopped flag on the member in the in-memory registry.
3. Returns a human-readable status message.

---

## 3. Infrastructure Tools

One-time setup and maintenance tools -- provisioning authentication, migrating to SSH keys, and updating the LLM CLI.

### `provision_llm_auth`

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
| Codex | `OPENAI_API_KEY` |
| Copilot | `GITHUB_TOKEN` |

### `setup_ssh_key`

Migrates a remote member from password-based SSH authentication to key-based authentication.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the remote member |
| `key_path` | string | no | Path to an existing SSH private key. If omitted, generates a new Ed25519 key pair |

### `update_llm_cli`

Updates the LLM CLI installation on a member to the latest version.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the target member |

---

## 4. Observability Tools

Two-layer monitoring -- a fleet-wide summary and a per-member deep dive.

### `fleet_status`

Provides a quick summary table of all fleet members.

**Parameters:** None.

**What it does:**

1. Loads all registered members from the registry.
2. **Checks each member in parallel** with a 10-second timeout per member:
   - Calls `strategy.testConnection()` -- for remote members, this opens (or reuses) an SSH connection. For local members, this always returns online.
   - If online, runs a **fleet-aware process check** to determine if Claude is actively running for *this specific member*.
3. Builds a formatted ASCII table.

**Output columns:**

| Column | Values | Meaning |
|--------|--------|---------|
| Name | member's friendly name | -- |
| Host | `host:port` or `(local)` | Connection target |
| Status | `online` / `OFFLINE` | Can we reach the member right now? |
| Busy? | `BUSY` / `idle` / `idle*` / `unknown` / `-` | Is a fleet LLM process running? |
| Session | first 8 chars of session ID or `(none)` | Active conversation thread |
| Last Activity | relative time (e.g. "5m ago", "2d ago") | When `execute_prompt` or `send_files` last touched this member |
| Tokens | `in: N / out: N` or omitted | Accumulated token totals for this member |

### `member_detail`

Deep-dive status for a single member -- connectivity, Claude CLI, session state, and system resources.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `member_id` | string | yes | UUID of the member to inspect |

**What it does:**

Assembles a multi-section report covering:
- **Connectivity:** SSH status, latency in ms, and auth method.
- **LLM CLI:** Installed semver string and authentication method.
- **Session:** Active session ID and last-used timestamp.
- **System Resources:** CPU load, memory usage, and working folder disk space.
- **Token Usage:** Accumulated lifetime token totals.
